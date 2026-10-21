"use strict";
// Этап 5: роли, приглашения, очередь предложений, история правок и видимость.
// Запуск: node --test test/access.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3178;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "тест-доступ-42";

let server = null;
let testDataDir = "";
let keeper = "";      // cookie хранителя (семейный пароль)
let editor = "";      // cookie редактора
let viewer = "";      // cookie наблюдателя
let editorId = "";
let viewerId = "";
let editorInvite = "";
let viewerInvite = "";

function startServer() {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-access-"));
  const env = { ...process.env, KORNI_PASSWORD: PASSWORD, DATA_DIR: testDataDir, PORT: String(PORT) };
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "pipe" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("сервер не запустился за 10с")), 10000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("Корни: общая база")) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  });
}

async function call(pathname, { cookie = "", ...opts } = {}) {
  return fetch(BASE + pathname, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
}
async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
function cookieOf(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

function person(id, name, sex, birth, death, extra = {}) {
  return {
    id, uid: "", name, native: "", nameVariants: "", sex, teip: "", tukhum: "",
    birth, death, father: null, mother: null, birthFull: "", deathFull: "",
    birthPlace: "", deathPlace: "", birthPlaceNow: "", deathPlaceNow: "",
    photo: "", photoMeta: null, info: "", occupation: "", residence: "", notes: "", source: "",
    spouses: [], unions: [], events: [], sources: [], memories: [], documents: [], ...extra,
  };
}
function archive(people) {
  return { format: "korni-local", version: 1, title: "Архив доступа", demo: false, log: [], people };
}
const seed = () => [
  person(1, "Ахмед", "M", 1930, 1999, {
    photo: "data:image/png;base64,AAAA",
    photoMeta: { caption: "Ахмед, 1950-е", date: "1950", source: "альбом", mediaId: "m1", people: [] },
    memories: [{ id: "m1", text: "Помнил запах села.", author: "Хеда", at: "2021", audio: null }],
  }),
  person(2, "Аминат", "F", 1934, null, { spouses: [1] }),
  person(3, "Муса", "M", 1956, null, { father: 1, mother: 2 }),
];

before(async () => {
  await startServer();
  const login = await call("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  keeper = cookieOf(login);
  assert.ok(keeper, "хранитель вошёл");
  const put = await call("/api/archive", {
    method: "PUT", cookie: keeper,
    body: JSON.stringify({ baseRev: 1, archive: archive(seed()) }),
  });
  assert.equal(put.status, 200, "архив записан хранителем");
});

after(() => { if (server) server.kill("SIGTERM"); });

test("хранитель видит полные данные и свои права", async () => {
  const me = await json(await call("/api/me", { cookie: keeper }));
  assert.equal(me.role, "keeper");
  assert.equal(me.canReview, true);
  assert.equal(me.visibility.living, true, "по умолчанию сведения о живых скрыты от остальных");
  const a = await json(await call("/api/archive", { cookie: keeper }));
  const ahmed = a.people.find((p) => p.id === 1);
  assert.equal(ahmed.birth, 1930);
  assert.ok(ahmed.photo);
  assert.equal(ahmed.memories.length, 1);
});

test("приглашение редактора одноразовое и даёт свою сессию", async () => {
  const created = await call("/api/access/invite", { method: "POST", cookie: keeper, body: JSON.stringify({ role: "editor", note: "Брат" }) });
  const invite = await json(created);
  assert.equal(created.status, 201);
  assert.match(invite.url, /\?invite=[a-f0-9]{48}$/);
  editorInvite = invite.url.split("invite=")[1];

  const preview = await json(await call(`/api/invite/${editorInvite}`));
  assert.equal(preview.role, "editor");
  assert.equal(preview.title, "Архив доступа");

  const accepted = await call(`/api/invite/${editorInvite}/accept`, { method: "POST", body: JSON.stringify({ name: "Идрис" }) });
  assert.equal(accepted.status, 200);
  editor = cookieOf(accepted);
  assert.ok(editor);

  const again = await call(`/api/invite/${editorInvite}/accept`, { method: "POST", body: JSON.stringify({ name: "Кто-то" }) });
  assert.equal(again.status, 410, "повторно ссылка не работает");

  const me = await json(await call("/api/me", { cookie: editor }));
  assert.equal(me.role, "editor");
  assert.equal(me.name, "Идрис");
  assert.equal(me.canEdit, true);
  assert.equal(me.canReview, false);

  const access = await json(await call("/api/access", { cookie: keeper }));
  editorId = access.users.find((u) => u.name === "Идрис").id;
  assert.ok(editorId);
});

test("редактор видит живых без личных сведений", async () => {
  const a = await json(await call("/api/archive", { cookie: editor }));
  const ahmed = a.people.find((p) => p.id === 1);
  const musa = a.people.find((p) => p.id === 3);
  assert.equal(ahmed.birth, 1930, "умерший виден полностью");
  assert.equal(musa.masked, true, "живой помечен как скрытый");
  assert.equal(musa.birth, undefined);
  assert.equal(musa.birthPlace, undefined);
  assert.equal(musa.photo, undefined);
  assert.equal(musa.memories, undefined);
  assert.equal(musa.father, 1, "связи остаются, иначе древо рассыплется");
});

test("редактор не может писать архив напрямую", async () => {
  const res = await call("/api/archive", { method: "PUT", cookie: editor, body: JSON.stringify({ baseRev: 2, archive: archive(seed()) }) });
  assert.equal(res.status, 403);
});

test("предложение редактора ждёт хранителя и применяется с историей", async () => {
  const a = await json(await call("/api/archive", { cookie: editor }));
  const before = a.people.find((p) => p.id === 1);
  const after = { ...before, name: "Ахмед-Хаджи" };
  const sent = await call("/api/proposals", {
    method: "POST", cookie: editor,
    body: JSON.stringify({ baseRev: a.rev, summary: "Изменён: Ахмед", patches: [{ op: "edit", id: 1, before, after }] }),
  });
  assert.equal(sent.status, 201);
  const proposalId = (await json(sent)).id;

  const mine = await json(await call("/api/proposals", { cookie: editor }));
  assert.equal(mine.proposals.length, 1, "редактор видит своё предложение");
  const queue = await json(await call("/api/proposals", { cookie: keeper }));
  assert.equal(queue.proposals.length, 1, "хранитель видит очередь");
  assert.equal(queue.proposals[0].author, "Идрис");

  const approved = await call(`/api/proposals/${proposalId}/approve`, { method: "POST", cookie: keeper });
  assert.equal(approved.status, 200);

  const afterApprove = await json(await call("/api/archive", { cookie: keeper }));
  assert.equal(afterApprove.people.find((p) => p.id === 1).name, "Ахмед-Хаджи");

  const hist = await json(await call("/api/history?personId=1", { cookie: keeper }));
  assert.ok(hist.history.length >= 2, "история содержит изменение");
  const last = hist.history[0];
  assert.equal(last.author, "Идрис");
  assert.equal(last.before.name, "Ахмед");
  assert.equal(last.after.name, "Ахмед-Хаджи");
});

test("скрытые поля не затираются предложением редактора", async () => {
  const a = await json(await call("/api/archive", { cookie: editor }));
  const musa = a.people.find((p) => p.id === 3);
  const after = { ...musa, name: "Муса-Хаджи" };
  const sent = await call("/api/proposals", {
    method: "POST", cookie: editor,
    body: JSON.stringify({ baseRev: a.rev, summary: "Имя", patches: [{ op: "edit", id: 3, before: musa, after }] }),
  });
  const id = (await json(sent)).id;
  const approved = await call(`/api/proposals/${id}/approve`, { method: "POST", cookie: keeper });
  assert.equal(approved.status, 200);
  const full = await json(await call("/api/archive", { cookie: keeper }));
  const stored = full.people.find((p) => p.id === 3);
  assert.equal(stored.name, "Муса-Хаджи");
  assert.equal(stored.birth, 1956, "год рождения не потерян");
});

test("устаревшее предложение не применяется молча", async () => {
  const a = await json(await call("/api/archive", { cookie: editor }));
  const before = a.people.find((p) => p.id === 1);
  const after = { ...before, name: "Ахмед Второй" };
  const sent = await call("/api/proposals", { method: "POST", cookie: editor, body: JSON.stringify({ baseRev: a.rev, summary: "Имя", patches: [{ op: "edit", id: 1, before, after }] }) });
  const id = (await json(sent)).id;

  // Пока предложение ждало, хранитель сам изменил этого человека.
  const cur = await json(await call("/api/archive", { cookie: keeper }));
  const p = cur.people.find((x) => x.id === 1);
  const edited = { ...p, name: "Ахмед Третий" };
  const put = await call("/api/archive", { method: "PUT", cookie: keeper, body: JSON.stringify({ baseRev: cur.rev, archive: { ...cur, people: cur.people.map((x) => (x.id === 1 ? edited : x)) } }) });
  assert.equal(put.status, 200);

  const approved = await call(`/api/proposals/${id}/approve`, { method: "POST", cookie: keeper });
  assert.equal(approved.status, 409, "конфликт виден хранителю");
  const still = await json(await call("/api/archive", { cookie: keeper }));
  assert.equal(still.people.find((x) => x.id === 1).name, "Ахмед Третий", "правка хранителя не затёрта");
});

test("история позволяет вернуть прежнюю версию", async () => {
  const hist = await json(await call("/api/history?personId=1", { cookie: keeper }));
  const target = hist.history.find((h) => h.before && h.before.name === "Ахмед-Хаджи");
  assert.ok(target, "есть запись с прежней версией");
  const restored = await call(`/api/history/${target.id}/restore`, { method: "POST", cookie: keeper });
  assert.equal(restored.status, 200);
  const a = await json(await call("/api/archive", { cookie: keeper }));
  assert.equal(a.people.find((p) => p.id === 1).name, "Ахмед-Хаджи");
  const after = await json(await call("/api/history?personId=1", { cookie: keeper }));
  assert.equal(after.history[0].action, "restore", "возврат тоже попадает в историю");
});

test("наблюдатель только смотрит и не может предлагать изменения", async () => {
  const created = await json(await call("/api/access/invite", { method: "POST", cookie: keeper, body: JSON.stringify({ role: "viewer" }) }));
  viewerInvite = created.url.split("invite=")[1];
  const accepted = await call(`/api/invite/${viewerInvite}/accept`, { method: "POST", body: JSON.stringify({ name: "Хеда" }) });
  viewer = cookieOf(accepted);
  const me = await json(await call("/api/me", { cookie: viewer }));
  assert.equal(me.role, "viewer");
  assert.equal(me.canEdit, false);

  const a = await call("/api/archive", { cookie: viewer });
  assert.equal(a.status, 200);
  const put = await call("/api/archive", { method: "PUT", cookie: viewer, body: JSON.stringify({ baseRev: 1, archive: archive(seed()) }) });
  assert.equal(put.status, 403);
  const proposal = await call("/api/proposals", { method: "POST", cookie: viewer, body: JSON.stringify({ summary: "x", patches: [{ op: "edit", id: 1, before: {}, after: {} }] }) });
  assert.equal(proposal.status, 403);
  const access = await call("/api/access", { cookie: viewer });
  assert.equal(access.status, 403, "список доступа виден только хранителю");
  const accessList = await json(await call("/api/access", { cookie: keeper }));
  viewerId = accessList.users.find((u) => u.name === "Хеда").id;
});

test("видимость фото и воспоминаний настраивается и действует на сервере", async () => {
  const off = await call("/api/access/visibility", { method: "POST", cookie: keeper, body: JSON.stringify({ living: true, photos: true, memories: true }) });
  assert.equal(off.status, 200);
  const a = await json(await call("/api/archive", { cookie: viewer }));
  const ahmed = a.people.find((p) => p.id === 1);
  assert.equal(ahmed.photo, undefined, "фото скрыто");
  assert.equal(ahmed.memories, undefined, "воспоминания скрыты");
  assert.equal(ahmed.birth, 1930, "умерший по-прежнему виден");

  const on = await json(await call("/api/access/visibility", { method: "POST", cookie: keeper, body: JSON.stringify({ living: true, photos: false, memories: false }) }));
  assert.equal(on.visibility.photos, false);
  const b = await json(await call("/api/archive", { cookie: viewer }));
  assert.ok(b.people.find((p) => p.id === 1).photo, "фото вернулось");
});

test("передача архива: новый хранитель и отзыв доступа", async () => {
  const transferred = await call("/api/access/transfer", { method: "POST", cookie: keeper, body: JSON.stringify({ userId: viewerId }) });
  assert.equal(transferred.status, 200);

  const meNew = await json(await call("/api/me", { cookie: viewer }));
  assert.equal(meNew.role, "keeper", "второй хранитель получает права без перелогина");
  const meOld = await json(await call("/api/me", { cookie: keeper }));
  assert.equal(meOld.role, "editor", "владелец пароля после передачи — редактор");

  const oldAccess = await call("/api/access", { cookie: keeper });
  assert.equal(oldAccess.status, 403, "управление доступом ушло новому хранителю");

  const revoked = await call("/api/access/revoke", { method: "POST", cookie: viewer, body: JSON.stringify({ userId: editorId }) });
  assert.equal(revoked.status, 200);
  const afterRevoke = await call("/api/archive", { cookie: editor });
  assert.equal(afterRevoke.status, 401, "сессия отозвана сразу");
});

test("редактор может отозвать своё предложение", async () => {
  const a = await json(await call("/api/archive", { cookie: keeper }));
  const p = a.people.find((x) => x.id === 2);
  const sent = await call("/api/proposals", { method: "POST", cookie: keeper, body: JSON.stringify({ summary: "Имя", patches: [{ op: "edit", id: 2, before: p, after: { ...p, name: "Аминат-Хаджи" } }] }) });
  const id = (await json(sent)).id;
  const withdrawn = await call(`/api/proposals/${id}`, { method: "DELETE", cookie: keeper });
  assert.equal(withdrawn.status, 200);
  const queue = await json(await call("/api/proposals", { cookie: viewer }));
  assert.ok(!queue.proposals.some((x) => x.id === id), "отозванного предложения в очереди нет");
});

test("история изменений для редактора маскирует сведения о живых", async () => {
  const editorHist = await json(await call("/api/history?personId=3", { cookie: keeper }));
  assert.ok(Array.isArray(editorHist.history), "история отдаётся");
  for (const h of editorHist.history) {
    if (h.before) assert.equal(h.before.birth, undefined, "год рождения живого скрыт в before");
    if (h.after) assert.equal(h.after.birth, undefined, "год рождения живого скрыт в after");
  }
});

test("хранитель может отозвать неиспользованную ссылку-приглашение", async () => {
  const inviteRes = await call("/api/access/invite", { method: "POST", cookie: viewer, body: JSON.stringify({ role: "editor", note: "Тест" }) });
  assert.equal(inviteRes.status, 201);
  const invData = await json(inviteRes);
  const token = invData.url.split("invite=")[1];

  const accessRes = await json(await call("/api/access", { cookie: viewer }));
  const inv = accessRes.invites.find((i) => i.note === "Тест");
  assert.ok(inv, "приглашение в списке");
  assert.equal(inv.used, false);
  assert.equal(inv.revoked, false);

  const revokeRes = await call("/api/access/revoke-invite", { method: "POST", cookie: viewer, body: JSON.stringify({ id: inv.id }) });
  assert.equal(revokeRes.status, 200);

  const acceptCheck = await call(`/api/invite/${token}`);
  assert.equal(acceptCheck.status, 410, "отозванное приглашение возвращает 410");

  const accessRes2 = await json(await call("/api/access", { cookie: viewer }));
  const inv2 = accessRes2.invites.find((i) => i.id === inv.id);
  assert.equal(inv2.revoked, true);
});

test("нельзя отозвать единственного хранителя или самого себя", async () => {
  const meRes = await json(await call("/api/me", { cookie: viewer }));
  const selfRevoke = await call("/api/access/revoke", { method: "POST", cookie: viewer, body: JSON.stringify({ userId: meRes.id }) });
  assert.equal(selfRevoke.status, 400, "нельзя отозвать самого себя");

  const selfDemote = await call("/api/access/role", { method: "POST", cookie: viewer, body: JSON.stringify({ userId: meRes.id, role: "editor" }) });
  assert.equal(selfDemote.status, 400, "нельзя понизить самого себя");
});

test("С1: пути вне /api/ и без сессии дают 404/200 без 500, CSP содержит blob", async () => {
  const resRobots = await call("/robots.txt");
  assert.equal(resRobots.status, 404);
  const csp = resRobots.headers.get("content-security-policy") || "";
  assert.ok(csp.includes("img-src 'self' data: blob:"), "CSP разрешает blob: в картинках");
  assert.ok(csp.includes("media-src 'self' blob:"), "CSP разрешает blob: в медиа");

  const resHead = await fetch(BASE + "/", { method: "HEAD" });
  assert.equal(resHead.status, 200, "HEAD / поддерживается");
});

test("К2: новый хранитель может восстановить права владельца пароля (owner)", async () => {
  // viewer сейчас хранитель, owner — редактор
  const restoreRes = await call("/api/access/role", {
    method: "POST", cookie: viewer,
    body: JSON.stringify({ userId: "owner", role: "keeper" }),
  });
  assert.equal(restoreRes.status, 200, "роль owner успешно изменена");
  const meOwner = await json(await call("/api/me", { cookie: keeper }));
  assert.equal(meOwner.role, "keeper", "владелец пароля снова стал хранителем");
});

test("С2: одновременное принятие одного приглашения атомарно (защита от гонки)", async () => {
  const invRes = await call("/api/access/invite", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ role: "viewer", note: "Гонка" }),
  });
  assert.equal(invRes.status, 201);
  const token = (await json(invRes)).url.split("invite=")[1];

  // Запускаем 4 параллельных запроса на принятие одной ссылки
  const parallel = await Promise.all([
    call(`/api/invite/${token}/accept`, { method: "POST", body: JSON.stringify({ name: "Клон 1" }) }),
    call(`/api/invite/${token}/accept`, { method: "POST", body: JSON.stringify({ name: "Клон 2" }) }),
    call(`/api/invite/${token}/accept`, { method: "POST", body: JSON.stringify({ name: "Клон 3" }) }),
    call(`/api/invite/${token}/accept`, { method: "POST", body: JSON.stringify({ name: "Клон 4" }) }),
  ]);

  const statuses = parallel.map((r) => r.status);
  const successes = statuses.filter((s) => s === 200);
  const conflicts = statuses.filter((s) => s === 409 || s === 410);
  assert.equal(successes.length, 1, "ровно один запрос принят успешно");
  assert.equal(conflicts.length, 3, "остальные параллельные запросы отклонены");
});

test("К1: сессия старше 30 дней без активности возвращает 401", async () => {
  const invRes = await call("/api/access/invite", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ role: "editor", note: "Срок" }),
  });
  const token = (await json(invRes)).url.split("invite=")[1];
  const acceptRes = await call(`/api/invite/${token}/accept`, {
    method: "POST", body: JSON.stringify({ name: "Идрис" }),
  });
  assert.equal(acceptRes.status, 200);
  const cookieIdris = cookieOf(acceptRes);
  const sessionToken = cookieIdris.split("=")[1];

  // Состариваем сессию на 31 день в базе
  const db = new DatabaseSync(path.join(testDataDir, "korni.db"));
  db.prepare("UPDATE sessions SET createdAt=? WHERE token=?").run(Date.now() - 31 * 24 * 3600 * 1000, sessionToken);
  db.close();

  const meExpired = await call("/api/me", { cookie: cookieIdris });
  assert.equal(meExpired.status, 401, "сессия старше 30 дней аннулирована");
});

test("К1: активная сессия продлевается со скользящим сроком", async () => {
  const invRes = await call("/api/access/invite", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ role: "editor", note: "Продление" }),
  });
  const token = (await json(invRes)).url.split("invite=")[1];
  const acceptRes = await call(`/api/invite/${token}/accept`, {
    method: "POST", body: JSON.stringify({ name: "Али" }),
  });
  assert.equal(acceptRes.status, 200);
  const cookieAli = cookieOf(acceptRes);
  const sessionToken = cookieAli.split("=")[1];

  // Прошло 25 часов с момента создания сессии
  const db = new DatabaseSync(path.join(testDataDir, "korni.db"));
  const agedTime = Date.now() - 25 * 3600 * 1000;
  db.prepare("UPDATE sessions SET createdAt=? WHERE token=?").run(agedTime, sessionToken);
  db.close();

  // Делаем запрос: сессия активна и должна продлиться
  const res = await call("/api/me", { cookie: cookieAli });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") || "";
  assert.ok(setCookie.includes("Max-Age="), "сервер выставил обновлённый cookie");

  const db2 = new DatabaseSync(path.join(testDataDir, "korni.db"));
  const row = db2.prepare("SELECT createdAt FROM sessions WHERE token=?").get(sessionToken);
  db2.close();
  assert.ok(row.createdAt > agedTime, "время сессии в БД сдвинулось вперёд");
});

test("К1: ссылка повторного входа (relogin) входит в того же userId без дублирования", async () => {
  // Создаём участника
  const invRes = await call("/api/access/invite", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ role: "editor", note: "Первичный" }),
  });
  const token1 = (await json(invRes)).url.split("invite=")[1];
  const acceptRes = await call(`/api/invite/${token1}/accept`, {
    method: "POST", body: JSON.stringify({ name: "Хасан" }),
  });
  assert.equal(acceptRes.status, 200);
  const cookieHas = cookieOf(acceptRes);
  const meHas = await json(await call("/api/me", { cookie: cookieHas }));
  const hasanId = meHas.id;
  assert.ok(hasanId, "получен ID участника");

  // Участник выходит
  const logoutRes = await call("/api/logout", { method: "POST", cookie: cookieHas });
  assert.equal(logoutRes.status, 200);

  // Хранитель генерирует ссылку повторного входа для Хасана через /api/access/relogin
  const reinvRes = await call("/api/access/relogin", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ userId: hasanId }),
  });
  assert.equal(reinvRes.status, 201);
  const reinvData = await json(reinvRes);
  assert.equal(reinvData.userId, hasanId);
  const token2 = reinvData.url.split("invite=")[1];

  // Проверяем инфо об инвайте
  const checkReinv = await json(await call(`/api/invite/${token2}`));
  assert.equal(checkReinv.isReentry, true);
  assert.equal(checkReinv.userName, "Хасан");

  // Принимаем повторный вход (имя не обязательно, сессия существующего участника)
  const acceptReinv = await call(`/api/invite/${token2}/accept`, {
    method: "POST", body: JSON.stringify({}),
  });
  assert.equal(acceptReinv.status, 200);
  const cookieReinv = cookieOf(acceptReinv);
  const meReinv = await json(await call("/api/me", { cookie: cookieReinv }));
  assert.equal(meReinv.id, hasanId, "ID участника сохранился");
  assert.equal(meReinv.name, "Хасан");

  // В списке участников Хасан только один
  const accessRes = await json(await call("/api/access", { cookie: keeper }));
  const hasanEntries = accessRes.users.filter((u) => u.name === "Хасан");
  assert.equal(hasanEntries.length, 1, "в users нет дубликатов Хасана");
});

test("К1: отозванный участник по relogin-ссылке не входит", async () => {
  // Создаём участника
  const invRes = await call("/api/access/invite", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ role: "viewer", note: "На отзыв" }),
  });
  const token1 = (await json(invRes)).url.split("invite=")[1];
  const acceptRes = await call(`/api/invite/${token1}/accept`, {
    method: "POST", body: JSON.stringify({ name: "Заур" }),
  });
  const cookieZaur = cookieOf(acceptRes);
  const zaurId = (await json(await call("/api/me", { cookie: cookieZaur }))).id;

  // Выпускаем relogin-ссылку до отзыва
  const reloginRes = await call("/api/access/relogin", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ userId: zaurId }),
  });
  assert.equal(reloginRes.status, 201);
  const reloginToken = (await json(reloginRes)).url.split("invite=")[1];

  // Хранитель отзывает Заура
  const revokeRes = await call("/api/access/revoke", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ userId: zaurId }),
  });
  assert.equal(revokeRes.status, 200);

  // Новая попытка выпустить relogin для отозванного даёт 404
  const reloginAfterRevoke = await call("/api/access/relogin", {
    method: "POST", cookie: keeper,
    body: JSON.stringify({ userId: zaurId }),
  });
  assert.equal(reloginAfterRevoke.status, 404);

  // Попытка принять ранее выданную relogin-ссылку даёт 403
  const acceptAttempt = await call(`/api/invite/${reloginToken}/accept`, {
    method: "POST", body: JSON.stringify({}),
  });
  assert.equal(acceptAttempt.status, 403, "отозванный участник не может войти по relogin");
});


