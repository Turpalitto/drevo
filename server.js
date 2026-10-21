"use strict";
// Корни — общий семейный архив. Сервер без внешних зависимостей.
// Хранение: SQLite (одна общая база для всех). Вход: общий семейный пароль.
//
// Env:
//   PORT=3000  DATA_DIR=./data  KORNI_PASSWORD=...  ALLOW_NO_PASSWORD=1 (только локально)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PASSWORD = process.env.KORNI_PASSWORD || "";
const ALLOW_NO_PASSWORD = process.env.ALLOW_NO_PASSWORD === "1";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 20 * 1024 * 1024;

if (!PASSWORD && !ALLOW_NO_PASSWORD) {
  console.error("Нужно задать KORNI_PASSWORD (семейный пароль). Пример: KORNI_PASSWORD=... node server.js");
  process.exit(1);
}
if (!PASSWORD) console.warn("ВНИМАНИЕ: сервер без пароля (ALLOW_NO_PASSWORD=1). Только для локальной проверки.");

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "korni.db"));
// WAL: читатели не блокируют писателя и наоборот. busy_timeout спасает от
// мгновенного SQLITE_BUSY, если два процесса откроют базу одновременно.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA busy_timeout = 5000;");
// Версионирование схемы базы данных через PRAGMA user_version.
// Позволяет накатывать миграции шаг за шагом в транзакциях и сохранять
// целостность данных между релизами сервера.
function applyMigrations(targetDb) {
  const currentVersion = targetDb.prepare("PRAGMA user_version").get().user_version;
  const migrations = [
    // v1: Базовые таблицы архива, сессий и заявок
    (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, createdAt INTEGER, userId TEXT, role TEXT);
        CREATE TABLE IF NOT EXISTS contributions(id TEXT PRIMARY KEY, createdAt INTEGER, status TEXT, payload TEXT);
      `);
      const cols = d.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
      for (const [name, type] of [["userId", "TEXT"], ["role", "TEXT"]]) {
        if (!cols.includes(name)) d.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
      }
    },
    // v2: Этап 5 — участники, одноразовые приглашения, предложения правок и история
    (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL, lastSeenAt INTEGER, revokedAt INTEGER);
        CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, note TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER, createdBy TEXT);
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, authorId TEXT, authorName TEXT, summary TEXT, baseRev INTEGER, status TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT, personId INTEGER NOT NULL, at INTEGER NOT NULL, authorId TEXT, authorName TEXT, action TEXT, before TEXT, after TEXT);
      `);
    },
    // v3: Индексы для производительности истории, предложений и проверок доступа
    (d) => {
      d.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_person ON history(personId, at);
        CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, createdAt);
        CREATE INDEX IF NOT EXISTS idx_invites_active ON invites(expiresAt, usedAt);
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, revokedAt);
      `);
    },
    // v4: Ссылки повторного входа (re-entry) для существующих участников
    (d) => {
      const cols = d.prepare("PRAGMA table_info(invites)").all().map((c) => c.name);
      if (!cols.includes("userId")) {
        d.exec("ALTER TABLE invites ADD COLUMN userId TEXT");
      }
    },
    // v5: С6 — Хеширование токенов сессий (sha256), чтобы токены не хранились в открытом виде
    (d) => {
      const rows = d.prepare("SELECT token, createdAt, userId, role FROM sessions").all();
      for (const row of rows) {
        const hash = crypto.createHash("sha256").update(row.token).digest("hex");
        d.prepare("DELETE FROM sessions WHERE token=?").run(row.token);
        d.prepare("INSERT OR REPLACE INTO sessions(token, createdAt, userId, role) VALUES(?,?,?,?)")
          .run(hash, row.createdAt, row.userId, row.role);
      }
    },
  ];

  for (let i = currentVersion; i < migrations.length; i++) {
    const nextVer = i + 1;
    targetDb.exec("BEGIN IMMEDIATE;");
    try {
      migrations[i](targetDb);
      targetDb.exec(`PRAGMA user_version = ${nextVer};`);
      targetDb.exec("COMMIT;");
    } catch (e) {
      targetDb.exec("ROLLBACK;");
      throw new Error(`Ошибка миграции схемы БД до v${nextVer}: ${e.message}`);
    }
  }
  return targetDb.prepare("PRAGMA user_version").get().user_version;
}
applyMigrations(db);

const ROLES = ["keeper", "editor", "viewer"];
const ROLE_TITLES = { keeper: "хранитель", editor: "редактор", viewer: "просмотр" };
// Роль владельца семейного пароля. После передачи архива он становится
// редактором: иначе передача ничего бы не значила — пароль возвращал бы права.
function ownerRole() {
  const value = kvGet("owner_role");
  return value === "editor" || value === "viewer" ? value : "keeper";
}
function activeKeeperCount() {
  const ownerIsKeeper = ownerRole() === "keeper" ? 1 : 0;
  const userKeepers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='keeper' AND revokedAt IS NULL").get().c;
  return ownerIsKeeper + userKeepers;
}
// Видимость для всех, кроме хранителя. По умолчанию сведения о живых скрыты:
// семейный архив не должен раскрывать даты и места жизни человека без его согласия.
const DEFAULT_VISIBILITY = { living: true, photos: false, memories: false };
function accessSettings() {
  try {
    const raw = JSON.parse(kvGet("access_settings") || "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_VISIBILITY };
    return {
      living: raw.living !== false,
      photos: raw.photos === true,
      memories: raw.memories === true,
    };
  } catch (e) {
    return { ...DEFAULT_VISIBILITY };
  }
}
function setAccessSettings(next) {
  const value = { living: next.living !== false, photos: next.photos === true, memories: next.memories === true };
  kvSet("access_settings", JSON.stringify(value));
  return value;
}
// Поля, которые не отдаём тем, кому закрыты сведения о живых.
const MASKED_FIELDS = [
  "birth", "death", "birthFull", "deathFull", "birthQ", "birthQ2", "deathQ", "deathQ2",
  "birthPlace", "deathPlace", "birthPlaceNow", "deathPlaceNow", "teip", "tukhum",
  "occupation", "residence", "info", "notes", "source", "photo", "photoMeta",
  "events", "sources", "memories", "documents", "unions",
];
function filterPerson(person, role, allPeople) {
  if (!person || typeof person !== "object" || role === "keeper") return person;
  const v = accessSettings();
  if (!v.living && !v.photos && !v.memories) return person;
  const copy = JSON.parse(JSON.stringify(person));
  if (v.living && isLiving(copy, allPeople)) {
    for (const key of MASKED_FIELDS) delete copy[key];
    copy.masked = true;
  }
  if (v.photos) { delete copy.photo; delete copy.photoMeta; }
  if (v.memories) delete copy.memories;
  return copy;
}
// Отдаём копию: фильтрация не должна менять архив в базе.
function filterArchive(archive, role) {
  if (role === "keeper") return archive;
  const copy = JSON.parse(JSON.stringify(archive));
  copy.people = (copy.people || []).map((p) => filterPerson(p, role, copy.people));
  return copy;
}

function freshArchive() {
  return { format: "korni-local", version: 1, rev: 1, title: "Моя родословная", demo: false, log: [], people: [] };
}
// Живым считаем человека без даты смерти, родившегося позже (текущий год − 110).
// Если дат нет вовсе — тоже считаем живым: молчание не должно раскрывать данные.
// Исключения: явный флаг deceased: true или ребёнок, родившийся ≥ 95 лет назад.
const LIVING_AGE_LIMIT = 110;
function isLiving(p, allPeople) {
  if (!p) return false;
  if (p.deceased === true) return false;
  if (p.death !== null && p.death !== undefined && p.death !== "") return false;
  if (typeof p.deathFull === "string" && p.deathFull.trim()) return false;
  const year = new Date().getFullYear();
  if (p.birth && p.birth <= year - LIVING_AGE_LIMIT) return false;
  if (typeof p.birthFull === "string" && p.birthFull.trim()) {
    const y = parseInt(p.birthFull.slice(0, 4), 10);
    if (!Number.isNaN(y) && y <= year - LIVING_AGE_LIMIT) return false;
  }
  if (Array.isArray(allPeople)) {
    for (const c of allPeople) {
      if (c && (c.father === p.id || c.mother === p.id)) {
        if (c.birth && c.birth <= year - 95) return false;
        if (typeof c.birthFull === "string" && c.birthFull.trim()) {
          const cy = parseInt(c.birthFull.slice(0, 4), 10);
          if (!Number.isNaN(cy) && cy <= year - 95) return false;
        }
      }
    }
  }
  return true;
}
function getArchive() {
  const row = db.prepare("SELECT value FROM kv WHERE key='archive'").get();
  if (!row) {
    const f = freshArchive();
    db.prepare("INSERT INTO kv(key,value) VALUES('archive',?)").run(JSON.stringify(f));
    kvSet("archive_rev", String(f.rev || 1));
    return f;
  }
  return JSON.parse(row.value);
}
function getArchiveRev() {
  const cached = kvGet("archive_rev");
  if (cached !== null && cached !== undefined && cached !== "") {
    const n = Number(cached);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  const a = getArchive();
  const rev = Number(a.rev) || 1;
  kvSet("archive_rev", String(rev));
  return rev;
}
function kvGet(key) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
  return row ? row.value : null;
}
function kvSet(key, value) {
  db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  return kvGet(key);
}
function kvDelete(key) {
  db.prepare("DELETE FROM kv WHERE key=?").run(key);
}

// --- пароль: scrypt с солью вместо голого SHA-256 ---
// Прежняя схема сравнивала SHA-256 пароля: без соли и без вычислительной
// стоимости перебор был слишком дешёвым. Теперь в kv лежит scrypt-хеш,
// а переменная окружения остаётся источником истины: сменился KORNI_PASSWORD —
// при следующем старте хеш пересчитывается автоматически.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const PASSWORD_HASH_KEY = "password_hash";

function scryptKey(password, salt, keylen, params) {
  return crypto.scryptSync(password, salt, keylen, params);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = scryptKey(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  let expected, actual;
  try {
    expected = Buffer.from(keyB64, "base64");
    actual = scryptKey(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  } catch (e) {
    return false;
  }
  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

let passwordHash = "";
function refreshPasswordHash() {
  if (!PASSWORD) { passwordHash = ""; return; }
  const stored = kvGet(PASSWORD_HASH_KEY);
  if (stored && verifyPassword(PASSWORD, stored)) { passwordHash = stored; return; }
  passwordHash = hashPassword(PASSWORD);
  kvSet(PASSWORD_HASH_KEY, passwordHash);
}
refreshPasswordHash();

function setArchive(a) {
  backupDailyBefore();
  db.prepare("INSERT INTO kv(key,value) VALUES('archive',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a));
  kvSet("archive_rev", String(Number(a.rev) || 1));
}

// --- история изменений по человеку ---
// Храним снимок «до» и «после»: этого достаточно, чтобы показать автору и
// времени, что именно изменилось, и вернуть прежние данные.
const HISTORY_LIMIT = 5000;
function maskPhotoForHistory(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (!obj.photo) return obj;
  if (typeof obj.photo === "object" && typeof obj.photo.photoRef === "string") return obj;
  const copy = { ...obj };
  const sample = typeof obj.photo === "string" ? obj.photo.slice(0, 100) : String(obj.photo);
  const hash = crypto.createHash("sha256").update(sample).digest("hex");
  copy.photo = { photoRef: hash };
  return copy;
}
function recordHistory(entries) {
  if (!entries.length) return;
  const stmt = db.prepare("INSERT INTO history(personId,at,authorId,authorName,action,before,after) VALUES(?,?,?,?,?,?,?)");
  for (const e of entries) {
    const maskedBefore = maskPhotoForHistory(e.before);
    const maskedAfter = maskPhotoForHistory(e.after);
    stmt.run(e.personId, e.at, e.authorId || "", e.authorName || "", e.action || "edit",
      maskedBefore == null ? null : JSON.stringify(maskedBefore), maskedAfter == null ? null : JSON.stringify(maskedAfter));
  }
  const count = db.prepare("SELECT COUNT(*) AS n FROM history").get().n;
  if (count > HISTORY_LIMIT) {
    const cut = db.prepare("SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?").get(HISTORY_LIMIT);
    if (cut) db.prepare("DELETE FROM history WHERE id <= ?").run(cut.id);
  }
}
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => {
    if (k === "masked") return false;
    if (before?.masked === true && before[k] === undefined) {
      const v = after?.[k];
      if (v === null || v === "" || v === undefined || (Array.isArray(v) && v.length === 0)) return false;
    }
    return !sameValue(before?.[k], after?.[k]);
  });
}
// Разница двух архивов на уровне людей: добавлен / изменён / удалён.
function diffPeople(before, after) {
  const map = new Map((before || []).map((p) => [p.id, p])), out = [], seen = new Set();
  for (const p of after || []) {
    seen.add(p.id);
    const old = map.get(p.id);
    if (!old) out.push({ op: "add", id: p.id, before: null, after: p });
    else if (!sameValue(old, p)) out.push({ op: "edit", id: p.id, before: old, after: p });
  }
  for (const p of before || []) if (!seen.has(p.id)) out.push({ op: "remove", id: p.id, before: p, after: null });
  return out;
}
// Применяем предложенные изменения к текущему архиву. Меняем только те поля,
// которые человек действительно правил: скрытые от него данные не затираются.
function applyPatches(archive, patches) {
  const conflicts = [], applied = [];
  const idMap = new Map();

  // Первый проход: для op "add" сервер выдаёт новый уникальный id
  for (const patch of patches) {
    if (!patch || !Number.isSafeInteger(patch.id)) continue;
    if (patch.op === "add") {
      const allIds = [...archive.people.map((p) => p.id), ...Array.from(idMap.values())];
      const newId = Math.max(0, ...allIds) + 1;
      idMap.set(patch.id, newId);
    }
  }

  // Перепривязка ссылок внутри того же пакета предложений
  function remapPerson(p) {
    if (!p || typeof p !== "object") return;
    if (idMap.has(p.father)) p.father = idMap.get(p.father);
    if (idMap.has(p.mother)) p.mother = idMap.get(p.mother);
    if (Array.isArray(p.spouses)) {
      p.spouses = p.spouses.map((s) => idMap.has(s) ? idMap.get(s) : s);
    }
    if (Array.isArray(p.unions)) {
      for (const u of p.unions) {
        if (u && idMap.has(u.spouse)) u.spouse = idMap.get(u.spouse);
      }
    }
    if (p.photoMeta && Array.isArray(p.photoMeta.people)) {
      p.photoMeta.people = p.photoMeta.people.map((id) => idMap.has(id) ? idMap.get(id) : id);
    }
  }

  if (idMap.size > 0) {
    for (const patch of patches) {
      if (!patch) continue;
      if (patch.op === "add" && idMap.has(patch.id)) {
        patch.id = idMap.get(patch.id);
        if (patch.after) patch.after.id = patch.id;
      }
      if (patch.after) remapPerson(patch.after);
      if (patch.before) remapPerson(patch.before);
    }
  }

  for (const patch of patches) {
    if (!patch || !Number.isSafeInteger(patch.id)) { conflicts.push({ id: null, reason: "bad" }); continue; }
    if (patch.op === "add") {
      if (archive.people.some((p) => p.id === patch.id)) { conflicts.push({ id: patch.id, reason: "exists" }); continue; }
      archive.people.push(patch.after);
      applied.push({ id: patch.id, action: "add", before: null, after: patch.after });
      continue;
    }
    const idx = archive.people.findIndex((p) => p.id === patch.id);
    if (idx < 0) { conflicts.push({ id: patch.id, reason: "missing" }); continue; }
    if (patch.op === "remove") {
      const removed = archive.people.splice(idx, 1)[0];
      // Снимаем ссылки на удалённого: иначе архив не пройдёт проверку связей.
      for (const p of archive.people) {
        if (p.father === patch.id) p.father = null;
        if (p.mother === patch.id) p.mother = null;
        if (Array.isArray(p.spouses)) p.spouses = p.spouses.filter((s) => s !== patch.id);
        if (Array.isArray(p.unions)) p.unions = p.unions.filter((u) => u.spouse !== patch.id);
      }
      applied.push({ id: patch.id, action: "remove", before: removed, after: null });
      continue;
    }
    const current = archive.people[idx];
    const fields = changedFields(patch.before, patch.after);
    const changed = fields.filter((k) => {
      if (patch.before?.masked === true && patch.before[k] === undefined) {
        const cur = current[k];
        if (cur === null || cur === "" || cur === undefined || (Array.isArray(cur) && cur.length === 0)) return false;
      }
      return !sameValue(current[k], patch.before?.[k]);
    });
    if (changed.length) { conflicts.push({ id: patch.id, reason: "changed", fields: changed }); continue; }
    const next = { ...current };
    for (const k of fields) next[k] = patch.after?.[k];
    archive.people[idx] = next;
    applied.push({ id: patch.id, action: "edit", before: current, after: next });
  }
  return { conflicts, applied };
}
function saveApplied(archive, applied, author, summary) {
  archive.rev = (archive.rev || 1) + 1;
  archive.log = [{ at: new Date().toISOString(), text: summary }, ...(Array.isArray(archive.log) ? archive.log : [])].slice(0, 100);
  checkArchive(archive);
  setArchive(archive);
  recordHistory(applied.map((a) => ({
    personId: a.id, at: Date.now(), authorId: author.id, authorName: author.name,
    action: a.action, before: a.before, after: a.after,
  })));
}

// --- ежедневные автоматические копии архива ---
// Снимок дня сохраняет состояние ДО первой правки дня (граница суток — по UTC).
// Наличие файла korni-<день>.json служит признаком того, что копия за день уже
// создана, исключая повторную перезапись как внутри процесса, так и после перезапуска.
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 30;
function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function setBackupStatus(status) {
  try { kvSet("backup_status", JSON.stringify(status)); } catch (e) { /* статус не важнее самой копии */ }
}
function backupDailyBefore() {
  const day = new Date().toISOString().slice(0, 10);
  const jsonFile = path.join(BACKUPS_DIR, `korni-${day}.json`);
  const dbFile = path.join(BACKUPS_DIR, `korni-${day}.db`);
  if (fs.existsSync(jsonFile)) return; // сегодня уже сохранили состояние до первой правки

  let existing = null;
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key='archive'").get();
    if (row && row.value) existing = JSON.parse(row.value);
  } catch (e) {
    return;
  }
  if (!existing || !Array.isArray(existing.people) || existing.people.length === 0) return;

  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(existing, null, 2));
    // Плюс согласованный снимок всей базы (архив, сессии, заявки) одним файлом:
    // VACUUM INTO безопаснее копирования файла на живой базе.
    let dbOk = fs.existsSync(dbFile);
    if (!dbOk) {
      try {
        db.exec(`VACUUM INTO ${sqlQuote(dbFile)}`);
        dbOk = fs.existsSync(dbFile);
      } catch (e) {
        console.warn("Не удалось снять снимок базы:", e.message);
      }
    }
    setBackupStatus({ at: new Date().toISOString(), day, ok: true, people: existing.people.length, db: dbOk });
    // Ротация по датам: у одного дня может быть и .json, и .db.
    const days = [...new Set(fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^korni-\d{4}-\d{2}-\d{2}\.(json|db)$/.test(f))
      .map((f) => f.slice(6, 16)))].sort();
    while (days.length > KEEP_BACKUPS) {
      const old = days.shift();
      for (const ext of ["json", "db"]) {
        const file = path.join(BACKUPS_DIR, `korni-${old}.${ext}`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    }
  } catch (e) {
    console.warn("Не удалось сделать ежедневную копию:", e.message);
    setBackupStatus({ at: new Date().toISOString(), ok: false, error: e.message });
  }
}
function contributionToken() {
  const row = db.prepare("SELECT value FROM kv WHERE key='contribution_token'").get();
  if (row) return row.value;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO kv(key,value) VALUES('contribution_token',?)").run(token);
  return token;
}
function rotateContributionToken() {
  const token = crypto.randomBytes(24).toString("hex");
  kvSet("contribution_token", token);
  return token;
}
function checkContribution(v) {
  if (!v || typeof v !== "object") throw Error("bad contribution");
  const text = (key, max, required = false) => {
    if (typeof v[key] !== "string" || v[key].length > max || (required && !v[key].trim())) throw Error("bad " + key);
  };
  text("name", 180, true); text("birthPlace", 120); text("info", 500); text("notes", 5000); text("submittedBy", 120, true); text("contact", 180);
  if (!["M", "F", "U"].includes(v.sex)) throw Error("bad sex");
  if (!["child", "parent", "spouse", "sibling", "other"].includes(v.relation)) throw Error("bad relation");
  const people = getArchive().people;
  if (!Number.isSafeInteger(v.relativeId) || !people.some((p) => p.id === v.relativeId)) throw Error("bad relative");
  if (v.secondParentId != null && (!Number.isSafeInteger(v.secondParentId) || v.secondParentId === v.relativeId || !people.some((p) => p.id === v.secondParentId))) throw Error("bad second parent");
  const year = new Date().getFullYear();
  if (v.birth !== null && (!Number.isInteger(v.birth) || v.birth < 1 || v.birth > year)) throw Error("bad birth");
}
function personFromContribution(v, archive) {
  const id = Math.max(0, ...archive.people.map((p) => p.id)) + 1;
  const source = [`Предложено: ${v.submittedBy.trim()}`, v.contact.trim() && `Контакт: ${v.contact.trim()}`].filter(Boolean).join(" · ");
  const rawInfo = (v.info || "").trim();
  const rawNotes = (v.notes || "").trim();
  const infoPrefix = rawInfo ? `Кратко (от заявителя): ${rawInfo}` : "";
  const combinedNotes = [infoPrefix, rawNotes].filter(Boolean).join("\n\n").slice(0, 10000);
  return { id, uid: crypto.randomUUID(), name: v.name.trim(), native: "", nameVariants: "", sex: v.sex, teip: "", birth: v.birth, death: null, father: null, mother: null, tukhum: "", notes: combinedNotes, source, birthFull: "", deathFull: "", birthPlace: v.birthPlace.trim(), deathPlace: "", photo: "", info: rawInfo.slice(0, 80), occupation: "", residence: "", spouses: [], events: [], sources: [], memories: [] };
}

// --- validation (same rules as client) ---
function validatePeople(people) {
  if (!Array.isArray(people) || people.length > 5000) throw Error("bad people");
  const ids = new Set(), map = new Map(), year = new Date().getFullYear();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const p of people) {
    if (!p || !Number.isSafeInteger(p.id) || p.id < 1 || ids.has(p.id)) throw Error("bad id");
    ids.add(p.id); map.set(p.id, p);
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 180) throw Error("bad name");
    if (!["M", "F", "U"].includes(p.sex)) throw Error("bad sex");
    for (const [key, max] of [["native", 180], ["nameVariants", 300], ["teip", 120], ["tukhum", 120], ["notes", 10000], ["source", 3000], ["birthPlace", 120], ["deathPlace", 120], ["birthPlaceNow", 120], ["deathPlaceNow", 120], ["occupation", 180], ["residence", 300], ["info", 80]]) {
      // Поля, добавленные позже, могут отсутствовать в старых архивах.
      if (p[key] === undefined && ["nameVariants", "occupation", "residence", "birthPlaceNow", "deathPlaceNow"].includes(key)) continue;
      if (typeof p[key] !== "string" || p[key].length > max) throw Error("bad " + key);
    }
    // Дополнительные разделы необязательны: старые архивы приходят без них.
    const sectionRules = [
      ["events", 100, [["date", 40, false], ["title", 120, true], ["place", 120, false], ["note", 500, false]]],
      ["sources", 50, [["title", 200, true], ["note", 1000, false]]],
      ["memories", 50, [["text", 5000, false], ["author", 120, false], ["at", 40, false]]],
      ["documents", 30, [["title", 200, true], ["date", 40, false], ["note", 500, false], ["mediaId", 60, false], ["fileName", 200, false], ["fileType", 100, false], ["eventId", 40, false]]],
    ];
    for (const [key, limit, checks] of sectionRules) {
      const list = p[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > limit) throw Error("bad " + key);
      for (const item of list) {
        if (!item || typeof item !== "object") throw Error("bad " + key);
        for (const [field, max, required] of checks) {
          if (typeof item[field] !== "string" || item[field].length > max || (required && !item[field].trim())) throw Error("bad " + key + "." + field);
        }
        if (key === "sources" && !["document", "oral", "assumption", "other"].includes(item.kind)) throw Error("bad source kind");
        // Воспоминание без текста допустимо, только если есть аудиозапись.
        if (key === "memories") {
          const audio = item.audio;
          if (audio !== undefined && audio !== null) {
            if (typeof audio !== "object" || typeof audio.mediaId !== "string" || !audio.mediaId.trim()) throw Error("bad memory audio");
          }
          if (!String(item.text || "").trim() && !(audio && audio.mediaId)) throw Error("bad memory text");
        }
      }
    }
    // Точность даты: второй год только у интервала и не раньше первого.
    for (const key of ["birth", "death"]) {
      const qual = p[key + "Q"], second = p[key + "Q2"];
      if (qual !== undefined && qual !== "" && !["exact", "abt", "bef", "aft", "between"].includes(qual)) throw Error("bad date quality");
      if (second !== undefined && second !== null) {
        if (qual !== "between") throw Error("bad date quality");
        if (!Number.isInteger(second) || second < 1 || second > year || (p[key] && second < p[key])) throw Error("bad date range");
      }
    }
    if (p.photoMeta !== undefined && p.photoMeta !== null) {
      const meta = p.photoMeta;
      if (typeof meta !== "object") throw Error("bad photo meta");
      for (const [key, max] of [["caption", 300], ["date", 40], ["source", 300], ["mediaId", 60]]) {
        if (typeof meta[key] !== "string" || meta[key].length > max) throw Error("bad photo meta." + key);
      }
      if (!Array.isArray(meta.people) || meta.people.some((x) => !Number.isSafeInteger(x))) throw Error("bad photo people");
    }
    // uid — необязательный стабильный идентификатор (GEDCOM 7 UID) в формате UUID.
    if (p.uid !== undefined && p.uid !== null && p.uid !== "" && (typeof p.uid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.uid))) {
      throw Error("bad uid");
    }
    if (p.deceased !== undefined && typeof p.deceased !== "boolean") {
      throw Error("bad deceased");
    }
    for (const key of ["birthFull", "deathFull"]) {
      if (typeof p[key] !== "string" || p[key].length > 10) throw Error("bad date");
      if (p[key] && !dateRe.test(p[key])) throw Error("bad date format");
    }
    if (typeof p.photo !== "string" || p.photo.length > 600000) throw Error("photo too big");
    if (p.photo && !p.photo.startsWith("data:image/")) throw Error("bad photo");
    for (const key of ["birth", "death"]) {
      if (p[key] !== null && (!Number.isInteger(p[key]) || p[key] < 1 || p[key] > year)) throw Error("bad year");
    }
    if (p.birthFull && p.birth !== null && Number(p.birthFull.slice(0, 4)) !== p.birth) throw Error("year/date mismatch");
    if (p.deathFull && p.death !== null && Number(p.deathFull.slice(0, 4)) !== p.death) throw Error("year/date mismatch");
    if (p.birth && p.death && p.death < p.birth) throw Error("death before birth");
    if (!Array.isArray(p.spouses)) throw Error("bad spouses");
    if (p.unions !== undefined) {
      if (!Array.isArray(p.unions) || p.unions.length > 20) throw Error("bad unions");
      for (const u of p.unions) {
        if (!u || !Number.isSafeInteger(u.spouse) || !p.spouses.includes(u.spouse)) throw Error("bad union");
        for (const [key, max] of [["from", 20], ["to", 20], ["note", 300]]) {
          if (typeof u[key] !== "string" || u[key].length > max) throw Error("bad union." + key);
        }
      }
    }
  }
  const degree = new Map(), children = new Map(people.map((p) => [p.id, []]));
  for (const p of people) {
    let count = 0;
    for (const key of ["father", "mother"]) {
      const id = p[key]; if (id === null) continue;
      if (!Number.isSafeInteger(id) || !map.has(id) || id === p.id) throw Error("bad parent");
      const parent = map.get(id);
      if ((key === "father" && parent.sex === "F") || (key === "mother" && parent.sex === "M")) throw Error("bad parent sex");
      if (parent.birth && p.birth && parent.birth >= p.birth) throw Error("parent younger than child");
      children.get(id).push(p.id); count++;
    }
    if (p.father !== null && p.father === p.mother) throw Error("same father and mother");
    for (const sid of p.spouses) {
      if (!Number.isSafeInteger(sid) || !map.has(sid) || sid === p.id) throw Error("bad spouse");
    }
    if (new Set(p.spouses).size !== p.spouses.length) throw Error("dup spouses");
    degree.set(p.id, count);
  }
  const queue = people.filter((p) => degree.get(p.id) === 0).map((p) => p.id);
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i])) {
      degree.set(child, degree.get(child) - 1);
      if (degree.get(child) === 0) queue.push(child);
    }
  }
  if (queue.length !== people.length) throw Error("cycle");
}
function ensureSymmetricSpouses(archive) {
  if (!archive || !Array.isArray(archive.people)) return;
  const map = new Map();
  for (const p of archive.people) {
    if (p && Number.isSafeInteger(p.id)) {
      if (!Array.isArray(p.spouses)) p.spouses = [];
      map.set(p.id, p);
    }
  }
  for (const p of archive.people) {
    if (!p || !Array.isArray(p.spouses)) continue;
    for (const sid of p.spouses) {
      const spouse = map.get(sid);
      if (spouse && spouse.id !== p.id) {
        if (!spouse.spouses.includes(p.id)) {
          spouse.spouses.push(p.id);
        }
      }
    }
  }
}
function checkArchive(v) {
  if (!v || v.format !== "korni-local" || v.version !== 1) throw Error("bad format");
  if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 100) throw Error("bad title");
  ensureSymmetricSpouses(v);
  validatePeople(v.people);
}

// --- sessions ---
// Сессия помнит, кто вошёл и с какой ролью. Токены в базе хранятся в виде sha256-хеша.
// Роль читается из users при каждом запросе: отзыв доступа и смена роли действуют сразу.
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function newSession(user = { id: "owner", role: "keeper" }) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);
  db.prepare("INSERT INTO sessions(token,createdAt,userId,role) VALUES(?,?,?,?)").run(hash, Date.now(), user.id, user.role);
  return token;
}
function sessionUser(req, res) {
  const token = parseCookies(req).korni_session;
  if (!token) return null;
  const hash = hashToken(token);
  const row = db.prepare("SELECT createdAt,userId,role FROM sessions WHERE token=?").get(hash);
  if (!row) return null;
  const now = Date.now();
  if (now - row.createdAt > SESSION_TTL_MS) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(hash);
    return null;
  }
  // Скользящая сессия: продлеваем активную сессию и обновляем cookie, если прошло более 24 часов
  if (now - row.createdAt > 24 * 3600 * 1000) {
    db.prepare("UPDATE sessions SET createdAt=? WHERE token=?").run(now, hash);
    if (res && typeof res.setHeader === "function") {
      res.setHeader("Set-Cookie", sessionCookie(req, token));
    }
  }
  if (!row.userId || row.userId === "owner") return { id: "owner", name: "Хранитель", role: ownerRole(), token };
  const user = db.prepare("SELECT name,role,lastSeenAt,revokedAt FROM users WHERE id=?").get(row.userId);
  if (!user || user.revokedAt) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(hash);
    return null;
  }
  // Обновляем визит участника не чаще раза в час
  if (now - (user.lastSeenAt || 0) > 3600 * 1000) {
    db.prepare("UPDATE users SET lastSeenAt=? WHERE id=?").run(now, row.userId);
  }
  if (user.role !== row.role) db.prepare("UPDATE sessions SET role=? WHERE token=?").run(user.role, hash);
  return { id: row.userId, name: user.name, role: user.role, token };
}
function sessionCookie(req, token) {
  const cookieAttrs = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
  const secureAttr = (requestIsHttps(req) && !("localhost" === req.headers.host?.split(":")[0])) ? "; Secure" : "";
  return `korni_session=${token}; ${cookieAttrs}${secureAttr}`;
}
function clearSessions() {
  db.prepare("DELETE FROM sessions WHERE createdAt < ?").run(Date.now() - SESSION_TTL_MS);
}
// Чистим просроченные сессии по таймеру, а не только при обращении.
setInterval(clearSessions, 6 * 3600 * 1000).unref();
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    // Битую процентную последовательность в cookie не считаем ошибкой сервера:
    // берём значение как есть, чтобы запрос не падал в 500.
    try { out[key] = decodeURIComponent(raw); } catch (e) { out[key] = raw; }
  }
  return out;
}
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      return xff.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress || "?";
}

const attempts = new Map(); // ip -> {count, resetAt}
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now > a.resetAt) { a.count = 0; a.resetAt = now + 5 * 60 * 1000; }
  a.count++;
  attempts.set(ip, a);
  // Просроченные записи удаляем, чтобы память не росла бесконечно:
  if (attempts.size > 1000) {
    for (const [key, value] of attempts) {
      if (now > value.resetAt) attempts.delete(key);
    }
  }
  return a.count > 10;
}
function resetRateLimit(ip) {
  attempts.delete(ip);
}

// --- http helpers ---
function send(res, code, body, type = "application/json") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Content-Length": buf.length });
  res.end(buf);
}
// Ответы API не кэшируем: архив меняется, а клиент опрашивает /api/rev.
const sendJson = (res, code, obj) => {
  res.setHeader("Cache-Control", "no-store");
  send(res, code, JSON.stringify(obj));
};
const TOO_BIG_ERROR = "Архив слишком большой для сохранения целиком (лимит 20 МБ). Сообщите хранителю.";
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let handled = false;
    req.on("data", (c) => {
      if (handled) return;
      size += c.length;
      if (size > MAX_BODY) {
        handled = true;
        const err = new Error(TOO_BIG_ERROR);
        err.status = 413;
        if (res && !res.headersSent) {
          sendJson(res, 413, { error: TOO_BIG_ERROR });
        }
        req.pause();
        req.on("data", () => {});
        req.resume();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!handled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!handled) reject(e);
    });
  });
}
function sameHash(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function validContributionToken(token) {
  return typeof token === "string" && token.length === contributionToken().length && sameHash(token, contributionToken());
}

const INDEX = fs.readFileSync(path.join(__dirname, "index.html"));
const ASSETS_DIR = path.join(__dirname, "assets");
const ASSET_RE = /^[A-Za-z0-9._-]+$/;
const ASSET_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function etagOf(buf) {
  return '"' + crypto.createHash("sha256").update(buf).digest("hex").slice(0, 20) + '"';
}
// Кодеки по предпочтению. Клиент получает только ту кодировку, которую сам
// объявил в Accept-Encoding, поэтому отсутствующие в браузере варианты просто
// не выбираются. Недоступные в сборке Node кодеки отсеиваются на старте.
const CODECS = [
  ["br", zlib.brotliCompressSync && ((buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }))],
  ["zstd", zlib.zstdCompressSync && ((buf) => zlib.zstdCompressSync(buf))],
  ["gzip", zlib.gzipSync && ((buf) => zlib.gzipSync(buf, { level: 9 }))],
].filter(([, encode]) => typeof encode === "function");

function buildVariants(buf) {
  const out = [];
  for (const [name, encode] of CODECS) {
    try {
      const body = encode(buf);
      if (body && body.length < buf.length) out.push([name, body]);
    } catch (e) { /* кодек недоступен — просто пропускаем */ }
  }
  return out;
}
function acceptsEncoding(header, name) {
  return String(header || "").toLowerCase().split(",").some((part) => part.trim().split(";")[0] === name);
}
function pickVariant(variants, header) {
  for (const variant of variants) if (acceptsEncoding(header, variant[0])) return variant;
  return null;
}

const INDEX_ETAG = etagOf(INDEX);
const INDEX_VARIANTS = buildVariants(INDEX);

// Статику читаем с диска один раз: файлы в assets/ не меняются на ходу.
// Несуществующие имена не кэшируются, чтобы кэш не раздувался от случайных запросов.
const assetCache = new Map();
function loadAsset(name) {
  if (assetCache.has(name)) return assetCache.get(name);
  if (!ASSET_RE.test(name)) return null;
  const file = path.join(ASSETS_DIR, name);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const entry = { buf, etag: etagOf(buf), type: ASSET_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream" };
  assetCache.set(name, entry);
  return entry;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  // Скрипт и стили встроены в index.html, поэтому 'unsafe-inline' обязателен.
  // Разрешаем blob: для предпросмотра фото (Image) и воспроизведения аудио (Audio).
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

// Защита Secure-cookie работает только на HTTPS (за прокси с HTTPS);
// на локальном HTTP=localhost cookie и так считается безопасным контекстом.
function requestIsHttps(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwarded.split(",")[0].trim() === "https" || req.socket.encrypted === true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
      applySecurityHeaders(res);
      if (req.headers["if-none-match"] === INDEX_ETAG) {
        res.writeHead(304, { ETag: INDEX_ETAG, "Cache-Control": "no-cache" });
        return res.end();
      }
      const variant = pickVariant(INDEX_VARIANTS, req.headers["accept-encoding"]);
      const body = variant ? variant[1] : INDEX;
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        ETag: INDEX_ETAG,
        "Cache-Control": "no-cache",
        Vary: "Accept-Encoding",
      };
      if (variant) headers["Content-Encoding"] = variant[0];
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      return res.end(body);
    }
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/healthz") {
      // Проверяем не только факт запуска, но и работоспособность БД (чтение/запись).
      try {
        const probe = kvSet("healthz-probe", "ok");
        if (probe !== "ok") throw Error("kv write mismatch");
        kvGet("healthz-probe");
        kvDelete("healthz-probe");
        if (req.method === "HEAD") return res.end();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        if (req.method === "HEAD") return res.end();
        return sendJson(res, 503, { ok: false, error: "database unavailable" });
      }
    }

    // Статика: бумажная текстура и другие файлы из assets/ (без обхода каталога).
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const asset = loadAsset(path.basename(url.pathname));
      if (!asset) return sendJson(res, 404, { error: "not found" });
      applySecurityHeaders(res);
      if (req.headers["if-none-match"] === asset.etag) {
        res.writeHead(304, { ETag: asset.etag, "Cache-Control": "public, max-age=86400" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": asset.type,
        "Content-Length": asset.buf.length,
        ETag: asset.etag,
        "Cache-Control": "public, max-age=86400",
      });
      return res.end(asset.buf);
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") return send(res, 204, "");

    if (url.pathname === "/api/contribution/context" && req.method === "GET") {
      if (!validContributionToken(url.searchParams.get("token"))) return sendJson(res, 403, { error: "Ссылка недействительна." });
      const archive = getArchive();
      // Гостевая ссылка отдаёт минимум: у живых людей год рождения не раскрываем,
      // а имя оставляем — иначе родственник не сможет выбрать себя в списке.
      const people = archive.people.map((p) => {
        const living = isLiving(p, archive.people);
        return { id: p.id, name: p.name, sex: p.sex, living, birth: living ? null : p.birth };
      });
      return sendJson(res, 200, { title: archive.title, people });
    }
    if (url.pathname === "/api/contributions" && req.method === "POST") {
      if (!validContributionToken(url.searchParams.get("token"))) return sendJson(res, 403, { error: "Ссылка недействительна." });
      const ip = clientIp(req);
      if (rateLimited("contribution:" + ip)) return sendJson(res, 429, { error: "Слишком много отправок. Попробуйте позже." });
      let body;
      try { body = JSON.parse(await readBody(req, res)); checkContribution(body); }
      catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "Проверьте заполненные данные." }); }
      const id = crypto.randomBytes(12).toString("hex");
      db.prepare("INSERT INTO contributions(id,createdAt,status,payload) VALUES(?,?,?,?)").run(id, Date.now(), "pending", JSON.stringify(body));
      return sendJson(res, 201, { ok: true, id });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Слишком много попыток. Подождите 5 минут." });
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      if (!passwordHash || !body.password || !verifyPassword(body.password, passwordHash)) {
        return sendJson(res, 401, { error: "Неверный пароль." });
      }
      resetRateLimit(ip);
      const role = ownerRole();
      const token = newSession({ id: "owner", role });
      res.setHeader("Set-Cookie", sessionCookie(req, token));
      return sendJson(res, 200, { ok: true, role, name: "Хранитель" });
    }

    // --- персональное приглашение ---
    // Ссылка одноразовая, живёт 7 дней. Принявший её получает собственную сессию
    // и роль; семейный пароль ему не передаётся.
    const inviteMatch = url.pathname.match(/^\/api\/invite\/([a-f0-9]{48})(\/accept)?$/);
    if (inviteMatch) {
      const [, rawToken, accept] = inviteMatch;
      const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const invite = db.prepare("SELECT * FROM invites WHERE token_hash=?").get(hash);
      if (!invite || invite.usedAt || invite.expiresAt < Date.now()) {
        return sendJson(res, 410, { error: "Приглашение недействительно или истекло." });
      }
      if (!accept && req.method === "GET") {
        let existingName = "";
        if (invite.userId) {
          const u = db.prepare("SELECT name FROM users WHERE id=?").get(invite.userId);
          if (u) existingName = u.name;
        }
        return sendJson(res, 200, {
          ok: true, role: invite.role, note: invite.note || "",
          title: getArchive().title, roles: ROLE_TITLES,
          isReentry: !!invite.userId, userName: existingName,
        });
      }
      if (accept && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
        if (!invite.userId && !name) return sendJson(res, 400, { error: "Укажите имя." });

        // С2: Атомарное погашение приглашения для предотвращения гонок
        const claim = db.prepare("UPDATE invites SET usedAt=? WHERE token_hash=? AND usedAt IS NULL").run(Date.now(), hash);
        if (claim.changes === 0) {
          return sendJson(res, 409, { error: "Приглашение уже использовано или отозвано." });
        }

        let userId = invite.userId;
        let role = invite.role;
        let userName = name;

        if (userId) {
          const existing = db.prepare("SELECT id, name, role, revokedAt FROM users WHERE id=?").get(userId);
          if (!existing || existing.revokedAt) {
            return sendJson(res, 403, { error: "Доступ участника был отозван." });
          }
          userName = existing.name;
          role = existing.role;
          db.prepare("UPDATE users SET lastSeenAt=? WHERE id=?").run(Date.now(), userId);
        } else {
          userId = crypto.randomUUID();
          userName = name;
          db.prepare("INSERT INTO users(id,name,role,createdAt,lastSeenAt) VALUES(?,?,?,?,?)").run(userId, name, invite.role, Date.now(), Date.now());
        }

        const token = newSession({ id: userId, role });
        res.setHeader("Set-Cookie", sessionCookie(req, token));
        return sendJson(res, 200, { ok: true, role, name: userName });
      }
      return sendJson(res, 405, { error: "method" });
    }

    // С1: всё, что не в /api/, отсекаем с 404 до обращения к user.role
    if (!url.pathname.startsWith("/api/")) {
      applySecurityHeaders(res);
      return sendJson(res, 404, { error: "not found" });
    }

    // everything below requires session
    const user = sessionUser(req, res);
    if (!user) return sendJson(res, 401, { error: "auth" });
    const isKeeper = user.role === "keeper";
    const canEdit = user.role === "keeper" || user.role === "editor";
    const deny = (res2) => sendJson(res2, 403, { error: "Недостаточно прав для этого действия." });

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const t = parseCookies(req).korni_session;
      if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(hashToken(t));
      res.setHeader("Set-Cookie", "korni_session=; HttpOnly; Path=/; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true, mode: "server", role: user.role, name: user.name, id: user.id,
        canEdit, canReview: isKeeper, visibility: accessSettings(), roles: ROLE_TITLES,
      });
    }
    if (url.pathname === "/api/rev" && req.method === "GET") {
      return sendJson(res, 200, { rev: getArchiveRev() });
    }
    // Статус последней автоматической копии: интерфейс показывает его в «Управлении»,
    // чтобы сбой копирования не остался незамеченным.
    if (url.pathname === "/api/backup-status" && req.method === "GET") {
      if (!isKeeper) return deny(res);
      let status = null;
      try { status = JSON.parse(kvGet("backup_status") || "null"); } catch (e) { status = null; }
      const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
      return sendJson(res, 200, { status, schemaVersion });
    }
    if (url.pathname === "/api/archive" && req.method === "GET") {
      return sendJson(res, 200, filterArchive(getArchive(), user.role));
    }
    if (url.pathname === "/api/archive" && req.method === "PUT") {
      if (!isKeeper) return deny(res);
      let body;
      try { body = JSON.parse(await readBody(req, res)); }
      catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "Некорректный JSON." }); }
      const cur = getArchive();
      if (!Number.isSafeInteger(body.baseRev) || body.baseRev !== (cur.rev || 1)) {
        return sendJson(res, 409, { error: "Архив изменился. Обновите страницу.", current: filterArchive(cur, user.role) });
      }
      try { checkArchive(body.archive); }
      catch (e) { return sendJson(res, 400, { error: "Проверка не пройдена." }); }
      const next = body.archive;
      const patches = diffPeople(cur.people, next.people);
      next.rev = (cur.rev || 1) + 1;
      next.log = Array.isArray(next.log)
        ? next.log.slice(0, 100).map((x) => ({
            at: typeof x?.at === "string" ? x.at.slice(0, 50) : "",
            text: typeof x?.text === "string" ? x.text.slice(0, 300) : "",
          }))
        : [];
      setArchive(next);
      // История пишется на каждое изменение человека. Массовый импорт в историю
      // не попадает: сотни записей «добавлен» только засорят её.
      if (patches.length <= 100) {
        recordHistory(patches.map((p) => ({
          personId: p.id, at: Date.now(), authorId: user.id, authorName: user.name,
          action: p.op === "add" ? "add" : p.op === "remove" ? "remove" : "edit",
          before: p.before, after: p.after,
        })));
      }
      return sendJson(res, 200, { ok: true, rev: next.rev });
    }

    // --- предложенные изменения (редактор → хранитель) ---
    if (url.pathname === "/api/proposals" && req.method === "POST") {
      if (!canEdit) return deny(res);
      let body;
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "Некорректный JSON." }); }
      const patches = Array.isArray(body.patches) ? body.patches.slice(0, 300) : [];
      if (!patches.length) return sendJson(res, 400, { error: "Нет изменений." });
      for (const p of patches) {
        if (!p || !Number.isSafeInteger(p.id) || !["add", "edit", "remove"].includes(p.op)) return sendJson(res, 400, { error: "Некорректное изменение." });
        if (p.op !== "remove" && (!p.after || typeof p.after !== "object")) return sendJson(res, 400, { error: "Некорректное изменение." });
      }
      const summary = typeof body.summary === "string" ? body.summary.slice(0, 300) : "Изменение";
      const id = crypto.randomBytes(12).toString("hex");
      db.prepare("INSERT INTO proposals(id,createdAt,authorId,authorName,summary,baseRev,status,payload) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, Date.now(), user.id, user.name, summary, Number(body.baseRev) || 0, "pending", JSON.stringify({ patches }));
      return sendJson(res, 201, { ok: true, id });
    }
    if (url.pathname === "/api/proposals" && req.method === "GET") {
      const rows = isKeeper
        ? db.prepare("SELECT * FROM proposals WHERE status='pending' ORDER BY createdAt ASC").all()
        : db.prepare("SELECT * FROM proposals WHERE status='pending' AND authorId=? ORDER BY createdAt DESC").all(user.id);
      return sendJson(res, 200, {
        proposals: rows.map((row) => ({
          id: row.id, at: row.createdAt, author: row.authorName, authorId: row.authorId,
          summary: row.summary, baseRev: row.baseRev, status: row.status,
          patches: JSON.parse(row.payload).patches,
        })),
      });
    }
    const proposalAction = url.pathname.match(/^\/api\/proposals\/([a-f0-9]{24})\/(approve|reject)$/);
    if (proposalAction && req.method === "POST") {
      if (!isKeeper) return deny(res);
      const [, id, action] = proposalAction;
      const row = db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
      if (!row || row.status !== "pending") return sendJson(res, 404, { error: "Предложение уже обработано." });
      if (action === "reject") {
        db.prepare("UPDATE proposals SET status='rejected' WHERE id=?").run(id);
        return sendJson(res, 200, { ok: true });
      }
      const patches = JSON.parse(row.payload).patches;
      const archive = getArchive();
      const { conflicts, applied } = applyPatches(archive, patches);
      if (conflicts.length) return sendJson(res, 409, { error: "Данные изменились после отправки. Отклоните предложение и попросите повторить.", conflicts });
      try { saveApplied(archive, applied, { id: row.authorId, name: row.authorName }, `Принято предложение: ${row.summary}`); }
      catch (e) { return sendJson(res, 409, { error: "Изменение противоречит данным архива. Проверьте связи вручную." }); }
      db.prepare("UPDATE proposals SET status='approved' WHERE id=?").run(id);
      return sendJson(res, 200, { ok: true, rev: archive.rev, applied: applied.length });
    }
    const proposalWithdraw = url.pathname.match(/^\/api\/proposals\/([a-f0-9]{24})$/);
    if (proposalWithdraw && req.method === "DELETE") {
      const id = proposalWithdraw[1];
      const row = db.prepare("SELECT authorId,status FROM proposals WHERE id=?").get(id);
      if (!row || row.status !== "pending") return sendJson(res, 404, { error: "Предложение не найдено." });
      if (!isKeeper && row.authorId !== user.id) return deny(res);
      db.prepare("UPDATE proposals SET status='withdrawn' WHERE id=?").run(id);
      return sendJson(res, 200, { ok: true });
    }

    // --- история изменений по человеку ---
    if (url.pathname === "/api/history" && req.method === "GET") {
      if (!canEdit) return deny(res);
      const personId = Number(url.searchParams.get("personId"));
      if (!Number.isSafeInteger(personId)) return sendJson(res, 400, { error: "bad person" });
      const rows = db.prepare("SELECT * FROM history WHERE personId=? ORDER BY id DESC LIMIT 40").all(personId);
      const archive = getArchive();
      return sendJson(res, 200, {
        history: rows.map((row) => ({
          id: row.id, at: row.at, author: row.authorName || "—", action: row.action,
          before: row.before ? filterPerson(JSON.parse(row.before), user.role, archive.people) : null,
          after: row.after ? filterPerson(JSON.parse(row.after), user.role, archive.people) : null,
        })),
      });
    }
    const restoreMatch = url.pathname.match(/^\/api\/history\/(\d+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      if (!isKeeper) return deny(res);
      const row = db.prepare("SELECT * FROM history WHERE id=?").get(Number(restoreMatch[1]));
      if (!row) return sendJson(res, 404, { error: "Запись не найдена." });
      const archive = getArchive();
      const idx = archive.people.findIndex((p) => p.id === row.personId);
      const target = row.before ? JSON.parse(row.before) : null;
      if (!target) return sendJson(res, 409, { error: "Для этой записи нет прежней версии." });
      if (idx < 0) return sendJson(res, 409, { error: "Человек удалён из архива." });
      const before = archive.people[idx];
      const nextPerson = { ...target };
      if (nextPerson.photo && typeof nextPerson.photo === "object" && typeof nextPerson.photo.photoRef === "string") {
        nextPerson.photo = before.photo || "";
      }
      archive.people[idx] = nextPerson;
      try { saveApplied(archive, [{ id: row.personId, action: "restore", before, after: nextPerson }], user, `Возвращена прежняя версия записи`); }
      catch (e) { return sendJson(res, 409, { error: "Прежняя версия противоречит текущим связям. Проверьте вручную." }); }
      return sendJson(res, 200, { ok: true, rev: archive.rev });
    }

    // --- доступ: пользователи, приглашения, видимость ---
    if (url.pathname === "/api/access" && req.method === "GET") {
      if (!isKeeper) return deny(res);
      const users = db.prepare("SELECT id,name,role,createdAt,lastSeenAt,revokedAt FROM users ORDER BY createdAt ASC").all()
        .map((u) => ({ id: u.id, name: u.name, role: u.role, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, revoked: !!u.revokedAt }));
      const invites = db.prepare("SELECT token_hash,role,note,createdAt,expiresAt,usedAt,userId FROM invites ORDER BY createdAt DESC LIMIT 20").all()
        .map((i) => ({ id: i.token_hash, role: i.role, note: i.note || "", createdAt: i.createdAt, expiresAt: i.expiresAt, used: (i.usedAt || 0) > 0, revoked: i.usedAt === -1, userId: i.userId || null }));
      return sendJson(res, 200, { users, invites, visibility: accessSettings(), roles: ROLE_TITLES, owner: "Хранитель", ownerRole: ownerRole() });
    }
    if (url.pathname === "/api/access/revoke-invite" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      if (typeof body.id !== "string") return sendJson(res, 400, { error: "bad invite id" });
      const inv = db.prepare("SELECT usedAt FROM invites WHERE token_hash=?").get(body.id);
      if (!inv) return sendJson(res, 404, { error: "Приглашение не найдено." });
      if (inv.usedAt) return sendJson(res, 409, { error: "Приглашение уже использовано или отозвано." });
      db.prepare("UPDATE invites SET usedAt=-1 WHERE token_hash=?").run(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/access/invite" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      const role = ROLES.includes(body.role) ? body.role : "viewer";
      if (role === "keeper") return sendJson(res, 400, { error: "Второго хранителя назначают из списка участников." });
      const token = crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 120) : "";
      const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
      db.prepare("INSERT INTO invites(token_hash,role,note,createdAt,expiresAt,createdBy) VALUES(?,?,?,?,?,?)")
        .run(hash, role, note, Date.now(), expiresAt, user.id);
      const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (requestIsHttps(req) ? "https" : "http");
      const origin = `${proto}://${req.headers.host}`;
      return sendJson(res, 201, { ok: true, url: `${origin}/?invite=${token}`, role, expiresAt });
    }
    if (url.pathname === "/api/access/relogin" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      if (typeof body.userId !== "string" || !body.userId.trim()) return sendJson(res, 400, { error: "bad userId" });
      const targetUser = db.prepare("SELECT id, name, role, revokedAt FROM users WHERE id=?").get(body.userId.trim());
      if (!targetUser || targetUser.revokedAt) return sendJson(res, 404, { error: "Участник не найден или его доступ отозван." });
      const token = crypto.randomBytes(24).toString("hex");
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
      db.prepare("INSERT INTO invites(token_hash,role,note,createdAt,expiresAt,createdBy,userId) VALUES(?,?,?,?,?,?,?)")
        .run(hash, targetUser.role, "Повторный вход", Date.now(), expiresAt, user.id, targetUser.id);
      const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (requestIsHttps(req) ? "https" : "http");
      const origin = `${proto}://${req.headers.host}`;
      return sendJson(res, 201, { ok: true, url: `${origin}/?invite=${token}`, role: targetUser.role, expiresAt, userId: targetUser.id });
    }
    if (url.pathname === "/api/access/revoke" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      if (typeof body.userId !== "string") return sendJson(res, 400, { error: "bad user" });
      if (body.userId === user.id) return sendJson(res, 400, { error: "Нельзя отозвать доступ у самого себя." });
      const target = db.prepare("SELECT role, revokedAt FROM users WHERE id=?").get(body.userId);
      if (!target || target.revokedAt) return sendJson(res, 404, { error: "Участник не найден или уже отозван." });
      if (target.role === "keeper" && activeKeeperCount() <= 1) {
        return sendJson(res, 400, { error: "Нельзя лишить архив единственного хранителя." });
      }
      db.prepare("UPDATE users SET revokedAt=? WHERE id=?").run(Date.now(), body.userId);
      db.prepare("DELETE FROM sessions WHERE userId=?").run(body.userId);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/access/role" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      if (typeof body.userId !== "string" || !ROLES.includes(body.role)) return sendJson(res, 400, { error: "bad role" });
      if (body.userId === user.id && body.role !== "keeper") {
        return sendJson(res, 400, { error: "Хранитель не может понизить сам себя. Используйте передачу архива." });
      }
      if (body.role === "keeper" && body.userId === user.id) return sendJson(res, 400, { error: "Вы уже хранитель." });

      if (body.userId === "owner") {
        if (body.role !== "keeper" && activeKeeperCount() <= 1 && ownerRole() === "keeper") {
          return sendJson(res, 400, { error: "Нельзя лишить архив единственного хранителя." });
        }
        kvSet("owner_role", body.role);
        return sendJson(res, 200, { ok: true, ownerRole: body.role });
      }

      const target = db.prepare("SELECT role, revokedAt FROM users WHERE id=?").get(body.userId);
      if (!target || target.revokedAt) return sendJson(res, 404, { error: "Участник не найден." });
      if (target.role === "keeper" && body.role !== "keeper" && activeKeeperCount() <= 1) {
        return sendJson(res, 400, { error: "Нельзя лишить архив единственного хранителя." });
      }
      db.prepare("UPDATE users SET role=? WHERE id=? AND revokedAt IS NULL").run(body.role, body.userId);
      db.prepare("UPDATE sessions SET role=? WHERE userId=?").run(body.role, body.userId);
      return sendJson(res, 200, { ok: true });
    }
    // Передача архива: выбранный участник становится хранителем, владелец
    // семейного пароля — редактором. Вернуть права сможет новый хранитель.
    if (url.pathname === "/api/access/transfer" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      const target = db.prepare("SELECT id,name FROM users WHERE id=? AND revokedAt IS NULL").get(String(body.userId || ""));
      if (!target) return sendJson(res, 404, { error: "Участник не найден." });
      db.prepare("UPDATE users SET role='keeper' WHERE id=?").run(target.id);
      db.prepare("UPDATE sessions SET role='keeper' WHERE userId=?").run(target.id);
      if (user.id === "owner") kvSet("owner_role", "editor");
      return sendJson(res, 200, { ok: true, owner: target.name, selfRole: user.id === "owner" ? "editor" : user.role });
    }
    if (url.pathname === "/api/access/visibility" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      let body = {};
      try { body = JSON.parse(await readBody(req, res)); } catch (e) { if (res.headersSent || e?.status === 413) return; return sendJson(res, 400, { error: "bad request" }); }
      return sendJson(res, 200, { ok: true, visibility: setAccessSettings(body) });
    }

    if (url.pathname === "/api/contribution-link" && req.method === "GET") {
      if (!isKeeper) return deny(res);
      const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (requestIsHttps(req) ? "https" : "http");
      const origin = `${proto}://${req.headers.host}`;
      return sendJson(res, 200, { url: `${origin}/?contribute=${contributionToken()}` });
    }
    if (url.pathname === "/api/contribution-link/rotate" && req.method === "POST") {
      if (!isKeeper) return deny(res);
      const token = rotateContributionToken();
      const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (requestIsHttps(req) ? "https" : "http");
      const origin = `${proto}://${req.headers.host}`;
      return sendJson(res, 200, { ok: true, token, url: `${origin}/?contribute=${token}` });
    }
    if (url.pathname === "/api/contributions" && req.method === "GET") {
      if (!isKeeper) return deny(res);
      const rows = db.prepare("SELECT id,createdAt,payload FROM contributions WHERE status='pending' ORDER BY createdAt ASC").all();
      return sendJson(res, 200, { contributions: rows.map((row) => ({ id: row.id, createdAt: row.createdAt, ...JSON.parse(row.payload) })) });
    }
    const contributionAction = url.pathname.match(/^\/api\/contributions\/([a-f0-9]{24})\/(approve|reject)$/);
    if (contributionAction && req.method === "POST") {
      if (!isKeeper) return deny(res);
      const [, id, action] = contributionAction;
      const row = db.prepare("SELECT status,payload FROM contributions WHERE id=?").get(id);
      if (!row || row.status !== "pending") return sendJson(res, 404, { error: "Заявка уже обработана или не найдена." });
      if (action === "reject") {
        db.prepare("UPDATE contributions SET status='rejected' WHERE id=?").run(id);
        return sendJson(res, 200, { ok: true });
      }
      const payload = JSON.parse(row.payload), archive = getArchive(), relative = archive.people.find((p) => p.id === payload.relativeId);
      if (!relative) return sendJson(res, 409, { error: "Связанный человек больше не найден." });
      if (archive.people.some((p) => p.name.trim().toLocaleLowerCase("ru") === payload.name.trim().toLocaleLowerCase("ru") && p.birth === payload.birth)) {
        return sendJson(res, 409, { error: "В архиве уже есть человек с таким именем и годом рождения." });
      }
      const person = personFromContribution(payload, archive);
      if (payload.relation === "child") {
        if (relative.sex === "U") return sendJson(res, 409, { error: "У выбранного родителя не указан пол. Добавьте ребёнка вручную после проверки." });
        if (relative.sex === "F") person.mother = relative.id; else person.father = relative.id;
        if (payload.secondParentId != null) {
          const second = archive.people.find((p) => p.id === payload.secondParentId);
          if (!second || second.sex === "U" || second.sex === relative.sex) return sendJson(res, 409, { error: "Проверьте пол второго родителя и добавьте связь вручную." });
          if (second.sex === "F") person.mother = second.id; else person.father = second.id;
        }
      } else if (payload.relation === "parent") {
        if (person.sex === "U") return sendJson(res, 409, { error: "Для родителя нужно указать пол." });
        if (person.sex === "F" && relative.mother !== null) return sendJson(res, 409, { error: "У человека уже указана мать. Проверьте заявку вручную." });
        if (person.sex === "M" && relative.father !== null) return sendJson(res, 409, { error: "У человека уже указан отец. Проверьте заявку вручную." });
        if (person.sex === "F") relative.mother = person.id; else relative.father = person.id;
      } else if (payload.relation === "spouse") {
        person.spouses.push(relative.id); relative.spouses = [...new Set([...(relative.spouses || []), person.id])];
      } else if (payload.relation === "sibling") {
        person.father = relative.father; person.mother = relative.mother;
      } else {
        person.notes = [`Указанная связь с ${relative.name}: ${payload.info || "другое родство"}.`, person.notes].filter(Boolean).join("\n");
      }
      archive.people.push(person);archive.rev = (archive.rev || 1) + 1;
      archive.log = [{ at: new Date().toISOString(), text: `Подтверждена заявка: ${person.name}` }, ...(Array.isArray(archive.log) ? archive.log : [])].slice(0, 100);
      try { checkArchive(archive); }
      catch (e) { return sendJson(res, 409, { error: "Связь противоречит данным архива. Отклоните заявку и добавьте человека вручную." }); }
      setArchive(archive);db.prepare("UPDATE contributions SET status='approved' WHERE id=?").run(id);
      recordHistory([{ personId: person.id, at: Date.now(), authorId: user.id, authorName: user.name, action: "add", before: null, after: person }]);
      return sendJson(res, 200, { ok: true, personId: person.id, rev: archive.rev });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (res.headersSent) return;
    console.error("Ошибка обработки запроса:", e && e.message ? e.message : e);
    return sendJson(res, 500, { error: "server error" });
  }
});

server.on("error", (e) => {
  console.error(`Не удалось запустить сервер на порту ${PORT}: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, () => console.log(`Корни: общая база на порту ${PORT}, данные в ${DATA_DIR}`));

// Graceful shutdown: аккуратно закрываем HTTP, затем SQLite, чтобы не потерять данные.
function closeDatabase() {
  try { db.close(); } catch (e) { /* уже закрыта */ }
}
process.on("SIGTERM", () => {
  console.log("Получен SIGTERM: останавливаемся.");
  server.close(() => { closeDatabase(); process.exit(0); });
  setTimeout(() => { closeDatabase(); process.exit(0); }, 5000).unref();
});
process.on("SIGINT", () => {
  console.log("Прерывание: закрываемся.");
  server.close(() => { closeDatabase(); process.exit(0); });
  setTimeout(() => { closeDatabase(); process.exit(0); }, 5000).unref();
});
