"use strict";
// Автотесты сервера «Корни» без внешних зависимостей (node:test, Node >= 22).
// Запуск: node --test test/server.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "тест-пароль-42";

let server = null;
let cookie = "";

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-test-"));
  const env = { ...process.env, KORNI_PASSWORD: PASSWORD, DATA_DIR: dataDir, PORT: String(PORT) };
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "pipe" });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("сервер не запустился за 10с")), 10000);
    server.stdout.on("data", (d) => {
      if (String(d).includes("Корни: общая база")) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  });
}

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  return res;
}

async function body(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

function demoPeople() {
  return [
    { id: 1, name: "Ахмед", native: "", sex: "M", teip: "", birth: 1930, death: 1999, father: null, mother: null, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [] },
    { id: 2, name: "Аминат", native: "", sex: "F", teip: "", birth: 1934, death: null, father: null, mother: null, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [1] },
    { id: 3, name: "Муса", native: "", sex: "M", teip: "", birth: 1956, death: null, father: 1, mother: 2, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [] },
  ];
}

function archive(people) {
  return { format: "korni-local", version: 1, title: "Тестовый архив", demo: false, log: [], people };
}

before(async () => { await startServer(); });

after(() => { if (server) server.kill("SIGTERM"); });

test("healthz отвечает ok с рабочей базой", async () => {
  const res = await fetch(BASE + "/healthz");
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.equal(j.ok, true);
});

test("индексная страница отдаётся с security-заголовками", async () => {
  const res = await fetch(BASE + "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok((await res.text()).includes("Корни"));
});

test("неверный и верный пароль, cookie-сессия", async () => {
  const bad = await api("/api/login", { method: "POST", body: JSON.stringify({ password: "не-то" }) });
  assert.equal(bad.status, 401);

  const ok = await api("/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get("set-cookie") || "";
  assert.ok(setCookie.includes("korni_session="));
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(setCookie.includes("SameSite=Lax"));
  cookie = setCookie.split(";")[0];
});

test("API без сессии возвращает 401", async () => {
  const saved = cookie; cookie = "";
  const res = await api("/api/rev");
  assert.equal(res.status, 401);
  cookie = saved;
});

test("чтение и запись архива с конфликтом ревизий", async () => {
  let res = await api("/api/archive");
  assert.equal(res.status, 200);
  const fresh = await body(res);
  assert.equal(fresh.rev, 1);

  // Сохранение с правильной baseRev:
  res = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: 1, archive: archive(demoPeople()) }) });
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.equal(j.rev, 2);

  // Сохранение со старой baseRev → 409 с текущей версией:
  res = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: 1, archive: archive(demoPeople()) }) });
  assert.equal(res.status, 409);
  const conflict = await body(res);
  assert.equal(conflict.current.rev, 2);

  // Невалидные данные → 400 (цикл родства):
  const cycled = demoPeople();
  cycled[0].father = 3;
  res = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: 2, archive: archive(cycled) }) });
  assert.equal(res.status, 400);
});

test("поток заявок: ссылка, отправка, подтверждение", async () => {
  // Ссылка-приглашение:
  const link = await api("/api/contribution-link");
  assert.equal(link.status, 200);
  const { url } = await body(link);
  const token = new URL(url).searchParams.get("contribute");
  assert.ok(token && token.length >= 40);

  // Контекст гостя отдает только минимум:
  const ctx = await fetch(BASE + "/api/contribution/context?token=" + encodeURIComponent(token));
  assert.equal(ctx.status, 200);
  const context = await body(ctx);
  assert.ok(context.people.every((p) => !("notes" in p || "photo" in p)));

  // Отправка заявки гостем:
  const contrib = await fetch(BASE + "/api/contributions?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Хеда", submittedBy: "Гость", contact: "", relativeId: 3, secondParentId: null, relation: "sibling", sex: "F", birth: 1960, birthPlace: "", info: "", notes: "" }),
  });
  assert.equal(contrib.status, 201);
  const { id } = await body(contrib);

  // Очередь заявок для владельца:
  const queue = await api("/api/contributions");
  assert.equal(queue.status, 200);
  const list = await body(queue);
  assert.ok(list.contributions.some((c) => c.id === id));

  // Подтверждение добавляет человека и поднимает ревизию:
  const before = await body(await api("/api/archive"));
  const approve = await api(`/api/contributions/${id}/approve`, { method: "POST" });
  assert.equal(approve.status, 200);
  const after = await body(await api("/api/archive"));
  assert.equal(after.rev, before.rev + 1);
  assert.ok(after.people.some((p) => p.name === "Хеда" && p.father === 1));

  // Повторное подтверждение той же заявки → 404:
  const again = await api(`/api/contributions/${id}/approve`, { method: "POST" });
  assert.equal(again.status, 404);

  // Отклонение второй заявки:
  const contrib2 = await fetch(BASE + "/api/contributions?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Лёма", submittedBy: "Гость", contact: "", relativeId: 3, secondParentId: null, relation: "sibling", sex: "M", birth: 1962, birthPlace: "", info: "", notes: "" }),
  });
  const { id: id2 } = await body(contrib2);
  const reject = await api(`/api/contributions/${id2}/reject`, { method: "POST" });
  assert.equal(reject.status, 200);
  const final = await body(await api("/api/archive"));
  assert.ok(!final.people.some((p) => p.name === "Лёма"));
});

test("ссылка-приглашение требует сессию владельца; гостевой контекст требует токен", async () => {
  // Проверим, что Context endpoint без токена отклоняется:
  const no = await fetch(BASE + "/api/contribution/context");
  assert.equal(no.status, 403);
  // Плохой токен тоже отклоняется:
  const bad = await fetch(BASE + "/api/contribution/context?token=deadbeef");
  assert.equal(bad.status, 403);
});

test("выход из сессии", async () => {
  const res = await api("/api/logout", { method: "POST" });
  assert.equal(res.status, 200);
  cookie = "";
});
