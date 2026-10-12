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
db.exec(`CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS contributions(id TEXT PRIMARY KEY, createdAt INTEGER, status TEXT, payload TEXT);`);

function freshArchive() {
  return { format: "korni-local", version: 1, rev: 1, title: "Моя родословная", demo: false, log: [], people: [] };
}
// Живым считаем человека без даты смерти, родившегося позже (текущий год − 110).
// Если дат нет вовсе — тоже считаем живым: молчание не должно раскрывать данные.
// Такой же подход по умолчанию в webtrees и Gramps Web.
const LIVING_AGE_LIMIT = 110;
function isLiving(p) {
  if (p.death !== null && p.death !== undefined) return false;
  if (typeof p.deathFull === "string" && p.deathFull.trim()) return false;
  const year = new Date().getFullYear();
  return !(p.birth && p.birth <= year - LIVING_AGE_LIMIT);
}
function getArchive() {
  const row = db.prepare("SELECT value FROM kv WHERE key='archive'").get();
  if (!row) {
    const f = freshArchive();
    db.prepare("INSERT INTO kv(key,value) VALUES('archive',?)").run(JSON.stringify(f));
    return f;
  }
  return JSON.parse(row.value);
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
  db.prepare("INSERT INTO kv(key,value) VALUES('archive',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a));
  backupDaily(a);
}

// --- ежедневные автоматические копии архива ---
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 30;
let lastBackupDay = "";
function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function backupDaily(archive) {
  if (!archive || !Array.isArray(archive.people) || archive.people.length === 0) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastBackupDay) return; // сегодня уже сохранили
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUPS_DIR, `korni-${day}.json`), JSON.stringify(archive, null, 2));
    // Плюс согласованный снимок всей базы (архив, сессии, заявки) одним файлом:
    // VACUUM INTO безопаснее копирования файла на живой базе.
    const dbFile = path.join(BACKUPS_DIR, `korni-${day}.db`);
    if (!fs.existsSync(dbFile)) { // VACUUM INTO не перезаписывает существующий файл
      try { db.exec(`VACUUM INTO ${sqlQuote(dbFile)}`); }
      catch (e) { console.warn("Не удалось снять снимок базы:", e.message); }
    }
    lastBackupDay = day;
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
  }
}
function contributionToken() {
  const row = db.prepare("SELECT value FROM kv WHERE key='contribution_token'").get();
  if (row) return row.value;
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO kv(key,value) VALUES('contribution_token',?)").run(token);
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
  return { id, uid: crypto.randomUUID(), name: v.name.trim(), native: "", sex: v.sex, teip: "", birth: v.birth, death: null, father: null, mother: null, tukhum: "", notes: v.notes.trim(), source, birthFull: "", deathFull: "", birthPlace: v.birthPlace.trim(), deathPlace: "", photo: "", info: v.info.trim().slice(0, 80), spouses: [] };
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
    for (const [key, max] of [["native", 180], ["teip", 120], ["tukhum", 120], ["notes", 10000], ["source", 3000], ["birthPlace", 120], ["deathPlace", 120], ["info", 80]]) {
      if (typeof p[key] !== "string" || p[key].length > max) throw Error("bad " + key);
    }
    // uid — необязательный стабильный идентификатор (GEDCOM 7 UID) в формате UUID.
    if (p.uid !== undefined && p.uid !== null && p.uid !== "" && (typeof p.uid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.uid))) {
      throw Error("bad uid");
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
function checkArchive(v) {
  if (!v || v.format !== "korni-local" || v.version !== 1) throw Error("bad format");
  if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 100) throw Error("bad title");
  validatePeople(v.people);
}

// --- sessions ---
function newSession() {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,createdAt) VALUES(?,?)").run(token, Date.now());
  return token;
}
function validSession(token) {
  if (!token) return false;
  const row = db.prepare("SELECT createdAt FROM sessions WHERE token=?").get(token);
  if (!row) return false;
  if (Date.now() - row.createdAt > SESSION_TTL_MS) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return false;
  }
  return true;
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
const assetCache = new Map();
function loadAsset(name) {
  if (assetCache.has(name)) return assetCache.get(name);
  const file = path.join(ASSETS_DIR, name);
  let entry = null;
  if (ASSET_RE.test(name) && fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    entry = { buf, etag: etagOf(buf), type: ASSET_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream" };
  }
  assetCache.set(name, entry);
  return entry;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  // Скрипт и стили встроены в index.html, поэтому 'unsafe-inline' обязателен.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
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
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      // Проверяем не только факт запуска, но и работоспособность БД (чтение/запись).
      try {
        const probe = kvSet("healthz-probe", "ok");
        if (probe !== "ok") throw Error("kv write mismatch");
        kvGet("healthz-probe");
        kvDelete("healthz-probe");
        return sendJson(res, 200, { ok: true });
      } catch (e) {
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
        const living = isLiving(p);
        return { id: p.id, name: p.name, sex: p.sex, living, birth: living ? null : p.birth };
      });
      return sendJson(res, 200, { title: archive.title, people });
    }
    if (url.pathname === "/api/contributions" && req.method === "POST") {
      if (!validContributionToken(url.searchParams.get("token"))) return sendJson(res, 403, { error: "Ссылка недействительна." });
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited("contribution:" + ip)) return sendJson(res, 429, { error: "Слишком много отправок. Попробуйте позже." });
      let body;
      try { body = JSON.parse(await readBody(req)); checkContribution(body); }
      catch (e) { return sendJson(res, 400, { error: "Проверьте заполненные данные." }); }
      const id = crypto.randomBytes(12).toString("hex");
      db.prepare("INSERT INTO contributions(id,createdAt,status,payload) VALUES(?,?,?,?)").run(id, Date.now(), "pending", JSON.stringify(body));
      return sendJson(res, 201, { ok: true, id });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "?";
      if (rateLimited(ip)) return sendJson(res, 429, { error: "Слишком много попыток. Подождите 5 минут." });
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: "bad request" }); }
      if (!passwordHash || !body.password || !verifyPassword(body.password, passwordHash)) {
        return sendJson(res, 401, { error: "Неверный пароль." });
      }
      const token = newSession();
      const cookieAttrs = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
      const secureAttr = (requestIsHttps(req) && !("localhost" === req.headers.host?.split(":")[0])) ? "; Secure" : "";
      res.setHeader("Set-Cookie", `korni_session=${token}; ${cookieAttrs}${secureAttr}`);
      return sendJson(res, 200, { ok: true });
    }

    // everything below requires session
    const authed = validSession(parseCookies(req).korni_session);
    const needAuth = url.pathname.startsWith("/api/");
    if (needAuth && !authed) return sendJson(res, 401, { error: "auth" });

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const t = parseCookies(req).korni_session;
      if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(t);
      res.setHeader("Set-Cookie", "korni_session=; HttpOnly; Path=/; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === "/api/me" && req.method === "GET") return sendJson(res, 200, { ok: true, mode: "server" });
    if (url.pathname === "/api/rev" && req.method === "GET") {
      return sendJson(res, 200, { rev: getArchive().rev || 1 });
    }
    if (url.pathname === "/api/archive" && req.method === "GET") {
      return sendJson(res, 200, getArchive());
    }
    if (url.pathname === "/api/archive" && req.method === "PUT") {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return sendJson(res, 400, { error: "Некорректный JSON." }); }
      const cur = getArchive();
      if (!Number.isSafeInteger(body.baseRev) || body.baseRev !== (cur.rev || 1)) {
        return sendJson(res, 409, { error: "Архив изменился. Обновите страницу.", current: cur });
      }
      try { checkArchive(body.archive); }
      catch (e) { return sendJson(res, 400, { error: "Проверка не пройдена." }); }
      const next = body.archive;
      next.rev = (cur.rev || 1) + 1;
      next.log = Array.isArray(next.log)
        ? next.log.slice(0, 100).map((x) => ({
            at: typeof x?.at === "string" ? x.at.slice(0, 50) : "",
            text: typeof x?.text === "string" ? x.text.slice(0, 300) : "",
          }))
        : [];
      setArchive(next);
      return sendJson(res, 200, { ok: true, rev: next.rev });
    }
    if (url.pathname === "/api/contribution-link" && req.method === "GET") {
      const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
      return sendJson(res, 200, { url: `${origin}/?contribute=${contributionToken()}` });
    }
    if (url.pathname === "/api/contributions" && req.method === "GET") {
      const rows = db.prepare("SELECT id,createdAt,payload FROM contributions WHERE status='pending' ORDER BY createdAt ASC").all();
      return sendJson(res, 200, { contributions: rows.map((row) => ({ id: row.id, createdAt: row.createdAt, ...JSON.parse(row.payload) })) });
    }
    const contributionAction = url.pathname.match(/^\/api\/contributions\/([a-f0-9]{24})\/(approve|reject)$/);
    if (contributionAction && req.method === "POST") {
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
      return sendJson(res, 200, { ok: true, personId: person.id, rev: archive.rev });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
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
