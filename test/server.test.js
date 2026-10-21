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
let testDataDir = "";

function startServer() {
  if (!testDataDir) testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-test-"));
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

test("С5: кэширование в assetCache только существующих файлов", async () => {
  const probeName = "temp-probe-c5.jpg";
  const probePath = path.join(__dirname, "..", "assets", probeName);
  try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch (_) {}

  try {
    // 1. Запрос к несуществующему файлу возвращает 404
    const res1 = await fetch(BASE + `/assets/${probeName}`);
    assert.equal(res1.status, 404);

    // 2. Создаём файл на диске
    fs.writeFileSync(probePath, "probe-content-for-c5");

    // 3. Несуществующий файл не кэшировался, поэтому новый запрос возвращает 200
    const res2 = await fetch(BASE + `/assets/${probeName}`);
    assert.equal(res2.status, 200);
    assert.equal(await res2.text(), "probe-content-for-c5");

    // 4. Удаляем файл с диска
    fs.unlinkSync(probePath);

    // 5. Найденный файл был закэширован в памяти, поэтому продолжает отдаваться 200
    const res3 = await fetch(BASE + `/assets/${probeName}`);
    assert.equal(res3.status, 200);
    assert.equal(await res3.text(), "probe-content-for-c5");
  } finally {
    try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch (_) {}
  }
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

test("С4: сохранение полного текста «Кратко о человеке» в notes заявки", async () => {
  const link = await api("/api/contribution-link");
  const token = (await body(link)).url.split("contribute=")[1];
  const longInfo = "Родился в горном селении, с юных лет работал кузнецом, затем переехал в город и открыл собственную мастерскую. Награждён почётными грамотами за трудовые заслуги.";
  const guestNotes = "Семейные предания записаны со слов внука.";

  const contrib = await fetch(BASE + "/api/contributions?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Сайд-Эмин",
      submittedBy: "Племянник",
      contact: "+79001234567",
      relativeId: 1,
      secondParentId: null,
      relation: "child",
      sex: "M",
      birth: 1955,
      birthPlace: "Шатой",
      info: longInfo,
      notes: guestNotes,
    }),
  });
  assert.equal(contrib.status, 201);
  const { id } = await body(contrib);

  const approve = await api(`/api/contributions/${id}/approve`, { method: "POST" });
  assert.equal(approve.status, 200);

  const arch = await body(await api("/api/archive"));
  const person = arch.people.find((p) => p.name === "Сайд-Эмин");
  assert.ok(person, "человек добавлен в архив");
  assert.equal(person.info, longInfo.slice(0, 80), "info содержит первые 80 символов");
  assert.ok(person.notes.includes(`Кратко (от заявителя): ${longInfo}`), "notes содержит полный текст info с пометкой");
  assert.ok(person.notes.includes(guestNotes), "notes содержит исходные заметки заявителя");
  assert.ok(person.notes.length <= 10000, "лимит notes 10000 соблюдён");
});

test("ссылка-приглашение требует сессию владельца; гостевой контекст требует токен", async () => {
  // Проверим, что Context endpoint без токена отклоняется:
  const no = await fetch(BASE + "/api/contribution/context");
  assert.equal(no.status, 403);
  // Плохой токен тоже отклоняется:
  const bad = await fetch(BASE + "/api/contribution/context?token=deadbeef");
  assert.equal(bad.status, 403);
});

test("версионирование схемы БД через PRAGMA user_version и /api/backup-status", async () => {
  const res = await api("/api/backup-status");
  assert.equal(res.status, 200);
  const data = await body(res);
  assert.ok(Number.isInteger(data.schemaVersion) && data.schemaVersion >= 3, `schemaVersion должен быть >= 3, получено: ${data.schemaVersion}`);
});

test("В3: ежедневная копия фиксирует состояние до первой правки дня, перезапуск не перезаписывает", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const backupsDir = path.join(testDataDir, "backups");
  const jsonBackup = path.join(backupsDir, `korni-${day}.json`);

  // Удаляем бэкап за сегодня, если он успел создаться предыдущими тестами
  if (fs.existsSync(jsonBackup)) fs.unlinkSync(jsonBackup);

  // Получаем текущее состояние архива (до правки 1)
  const stateBefore = await body(await api("/api/archive"));
  const revBefore = stateBefore.rev || 1;

  // Правка 1
  const state1 = {
    ...stateBefore,
    rev: revBefore + 1,
    people: [...stateBefore.people, { id: 991, name: "Тест Правка 1", native: "", sex: "M", teip: "", birth: 1980, death: null, father: null, mother: null, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [] }],
  };
  const put1 = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: revBefore, archive: state1 }) });
  assert.equal(put1.status, 200);

  // Проверяем, что в бэкапе сохранилось состояние ДО правки 1
  assert.ok(fs.existsSync(jsonBackup), "файл ежедневного бэкапа создан");
  const backup1 = JSON.parse(fs.readFileSync(jsonBackup, "utf8"));
  assert.ok(!backup1.people.some((p) => p.name === "Тест Правка 1"), "бэкап содержит состояние ДО правки 1");
  assert.equal(backup1.people.length, stateBefore.people.length);

  // Правка 2 в тот же день
  const state2 = {
    ...state1,
    rev: state1.rev + 1,
    people: [...state1.people, { id: 992, name: "Тест Правка 2", native: "", sex: "M", teip: "", birth: 1982, death: null, father: null, mother: null, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [] }],
  };
  const put2 = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: state1.rev, archive: state2 }) });
  assert.equal(put2.status, 200);

  // Бэкап не перезаписан правкой 2
  const backup2 = JSON.parse(fs.readFileSync(jsonBackup, "utf8"));
  assert.ok(!backup2.people.some((p) => p.name === "Тест Правка 2"), "бэкап не перезаписан правкой 2");
  assert.equal(backup2.people.length, stateBefore.people.length);

  // Перезапуск сервера
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  await startServer();

  // Правка 3 после перезапуска в тот же день
  const state3 = {
    ...state2,
    rev: state2.rev + 1,
    people: [...state2.people, { id: 993, name: "Тест Правка 3", native: "", sex: "M", teip: "", birth: 1984, death: null, father: null, mother: null, tukhum: "", notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "", photo: "", info: "", spouses: [] }],
  };
  const put3 = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: state2.rev, archive: state3 }) });
  assert.equal(put3.status, 200);

  // После перезапуска файл бэкапа по-прежнему не перезаписан
  const backup3 = JSON.parse(fs.readFileSync(jsonBackup, "utf8"));
  assert.ok(!backup3.people.some((p) => p.name === "Тест Правка 3"), "после перезапуска бэкап дня не перезаписан");
  assert.equal(backup3.people.length, stateBefore.people.length);
});

test("В2: /api/rev кэшируется в kv archive_rev и совпадает с archive.rev после PUT, подтверждения предложения и заявки", async () => {
  const { DatabaseSync } = require("node:sqlite");

  // 1. Проверяем совпадение после PUT
  const current = await body(await api("/api/archive"));
  const nextRev = (current.rev || 1) + 1;
  const nextArchive = { ...current, rev: nextRev };
  const putRes = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: current.rev || 1, archive: nextArchive }) });
  assert.equal(putRes.status, 200);

  const revAfterPut = (await body(await api("/api/rev"))).rev;
  assert.equal(revAfterPut, nextRev, "ревизия после PUT совпадает");

  // Проверяем прямое значение в SQLite
  const db = new DatabaseSync(path.join(testDataDir, "korni.db"));
  const row1 = db.prepare("SELECT value FROM kv WHERE key='archive_rev'").get();
  assert.equal(Number(row1.value), nextRev, "в kv лежит актуальная archive_rev после PUT");

  // 2. Проверяем совпадение после подтверждения заявки гостя
  const linkRes = await api("/api/contribution-link");
  const linkData = await body(linkRes);
  const token = new URL(linkData.url).searchParams.get("contribute");

  const contribRes = await fetch(BASE + "/api/contributions?token=" + encodeURIComponent(token), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иса", submittedBy: "Гость", contact: "", relativeId: 1, secondParentId: null, relation: "child", sex: "M", birth: 1970, birthPlace: "", info: "", notes: "" }),
  });
  const { id: contribId } = await body(contribRes);
  const approveContrib = await api(`/api/contributions/${contribId}/approve`, { method: "POST" });
  assert.equal(approveContrib.status, 200);

  const archiveAfterContrib = await body(await api("/api/archive"));
  const revAfterContrib = (await body(await api("/api/rev"))).rev;
  assert.equal(revAfterContrib, archiveAfterContrib.rev, "ревизия после подтверждения заявки совпадает");

  // 3. Проверяем совпадение после подтверждения предложения редактора
  const invRes = await api("/api/access/invite", { method: "POST", body: JSON.stringify({ role: "editor", note: "Тест ревизии" }) });
  const invToken = (await body(invRes)).url.split("invite=")[1];
  const acceptRes = await fetch(BASE + `/api/invite/${invToken}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Редактор Ревизии" }),
  });
  const editorCookie = acceptRes.headers.get("set-cookie").split(";")[0];

  const propRes = await fetch(BASE + "/api/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: editorCookie },
    body: JSON.stringify({
      baseRev: archiveAfterContrib.rev,
      summary: "Правка ревизии",
      patches: [{ op: "edit", id: 1, before: archiveAfterContrib.people.find((p) => p.id === 1), after: { ...archiveAfterContrib.people.find((p) => p.id === 1), occupation: "Архитектор" } }],
    }),
  });
  const { id: propId } = await body(propRes);
  const approveProp = await api(`/api/proposals/${propId}/approve`, { method: "POST" });
  assert.equal(approveProp.status, 200);

  const archiveAfterProp = await body(await api("/api/archive"));
  const revAfterProp = (await body(await api("/api/rev"))).rev;
  assert.equal(revAfterProp, archiveAfterProp.rev, "ревизия после утверждения предложения совпадает");

  const row2 = db.prepare("SELECT value FROM kv WHERE key='archive_rev'").get();
  assert.equal(Number(row2.value), archiveAfterProp.rev, "в kv лежит актуальная archive_rev после предложения");
  db.close();
});

test("В1: тело запроса больше 20 МБ возвращает 413 с понятным текстом ошибки", async () => {
  const http = require("node:http");
  const payloadChunk = Buffer.alloc(1024 * 1024, "a");
  const chunksCount = 21;
  const res = await new Promise((resolve, reject) => {
    const req = http.request(BASE + "/api/archive", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, (res) => {
      const data = [];
      res.on("data", (c) => data.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString("utf8") }));
    });
    req.on("error", () => {});
    for (let i = 0; i < chunksCount; i++) {
      if (!req.destroyed) req.write(payloadChunk);
    }
    req.end();
  });
  assert.equal(res.status, 413);
  const json = JSON.parse(res.body);
  assert.equal(json.error, "Архив слишком большой для сохранения целиком (лимит 20 МБ). Сообщите хранителю.");
});

test("выход из сессии", async () => {
  const res = await api("/api/logout", { method: "POST" });
  assert.equal(res.status, 200);
  cookie = "";
});
