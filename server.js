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
db.exec(`CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, createdAt INTEGER);
CREATE TABLE IF NOT EXISTS contributions(id TEXT PRIMARY KEY, createdAt INTEGER, status TEXT, payload TEXT);`);

function freshArchive() {
  return { format: "korni-local", version: 1, rev: 1, title: "Моя родословная", demo: false, log: [], people: [] };
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
function setArchive(a) {
  db.prepare("INSERT INTO kv(key,value) VALUES('archive',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a));
  backupDaily(a);
}

// --- ежедневные автоматические копии архива ---
const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const KEEP_BACKUPS = 30;
let lastBackupDay = "";
function backupDaily(archive) {
  if (!archive || !Array.isArray(archive.people) || archive.people.length === 0) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day === lastBackupDay) return; // сегодня уже сохранили
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const file = path.join(BACKUPS_DIR, `korni-${day}.json`);
    fs.writeFileSync(file, JSON.stringify(archive, null, 2));
    lastBackupDay = day;
    const entries = fs.readdirSync(BACKUPS_DIR).filter((f) => f.startsWith("korni-") && f.endsWith(".json")).sort();
    while (entries.length > KEEP_BACKUPS) { fs.unlinkSync(path.join(BACKUPS_DIR, entries.shift())); }
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
  return { id, name: v.name.trim(), native: "", sex: v.sex, teip: "", birth: v.birth, death: null, father: null, mother: null, tukhum: "", notes: v.notes.trim(), source, birthFull: "", deathFull: "", birthPlace: v.birthPlace.trim(), deathPlace: "", photo: "", info: v.info.trim().slice(0, 80), spouses: [] };
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
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj));
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

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
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
      return send(res, 200, INDEX, "text/html");
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

    if (url.pathname === "/api/contribution/context" && req.method === "GET") {
      if (!validContributionToken(url.searchParams.get("token"))) return sendJson(res, 403, { error: "Ссылка недействительна." });
      const archive = getArchive();
      return sendJson(res, 200, { title: archive.title, people: archive.people.map((p) => ({ id: p.id, name: p.name, sex: p.sex, birth: p.birth })) });
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
      if (!PASSWORD || !body.password || !sameHash(body.password, PASSWORD)) {
        return sendJson(res, 401, { error: "Неверный пароль." });
      }
      const token = newSession();
      const cookieAttrs = `HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
      const secureAttr = (requestIsHttps(req) && !("localhost" === req.headers.host?.split(":")[0])) ? "; Secure" : "";
      res.setHeader("Set-Cookie", `korni_session=${token}; ${cookieAttrs}${secureAttr}`);
      return sendJson(res, 200, { ok: true });
    }

    // everything below requires session
    clearSessions();
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
      next.log = Array.isArray(next.log) ? next.log.slice(0, 100) : [];
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
    return sendJson(res, 500, { error: "server error" });
  }
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
