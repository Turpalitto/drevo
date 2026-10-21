#!/usr/bin/env node
"use strict";
// Проверка фактического восстановления архива из резервной копии.
//
// Скрипт НЕ трогает рабочую базу: он поднимает отдельный сервер во временном
// каталоге, загружает в него копию и сравнивает результат с исходником.
//
//   node scripts/verify-restore.js                     # последняя копия из data/backups
//   node scripts/verify-restore.js path/to/korni.json  # конкретная копия
//   node scripts/verify-restore.js path/to/korni.db    # снимок базы
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BACKUPS = path.join(ROOT, "data", "backups");

function latestBackup() {
  if (!fs.existsSync(BACKUPS)) return null;
  const files = fs.readdirSync(BACKUPS)
    .filter((f) => /^korni-\d{4}-\d{2}-\d{2}\.(json|db)$/.test(f))
    .sort();
  // Предпочитаем JSON: он переносим между версиями.
  const json = files.filter((f) => f.endsWith(".json"));
  return path.join(BACKUPS, (json.length ? json : files).pop());
}

let file = process.argv[2] ? path.resolve(process.argv[2]) : latestBackup();
let syntheticDir = "";
if (!file || !fs.existsSync(file)) {
  console.log("В data/backups/ нет готовых копий. Проверяем восстановление на тестовой копии в изолированной среде...");
  syntheticDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-fixture-"));
  file = path.join(syntheticDir, "korni-test.json");
  const fixture = {
    format: "korni-local",
    version: 1,
    rev: 1,
    title: "Тестовая копия для проверки",
    demo: false,
    log: [],
    people: [
      {
        id: 1, uid: "11111111-1111-4111-8111-111111111111",
        name: "Ахмед", native: "Ахьмад", sex: "M",
        birth: 1930, death: 1999, birthFull: "", deathFull: "",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "Беной", tukhum: "",
        birthPlace: "Беной", birthPlaceNow: "", deathPlace: "", deathPlaceNow: "",
        photo: "", photoMeta: null, info: "", occupation: "", residence: "", notes: "", source: "",
        spouses: [2], unions: [], events: [], sources: [], memories: [], documents: []
      },
      {
        id: 2, uid: "22222222-2222-4222-8222-222222222222",
        name: "Аминат", native: "Аминат", sex: "F",
        birth: 1934, death: null, birthFull: "", deathFull: "",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "", tukhum: "",
        birthPlace: "", birthPlaceNow: "", deathPlace: "", deathPlaceNow: "",
        photo: "", photoMeta: null, info: "", occupation: "", residence: "", notes: "", source: "",
        spouses: [1], unions: [], events: [], sources: [], memories: [], documents: []
      }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
}

const isDb = file.endsWith(".db");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "korni-restore-"));
const port = 3400 + Math.floor(Math.random() * 400);
const password = "restore-check-" + Math.random().toString(36).slice(2);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    await sleep(120);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch (e) { /* сервер ещё стартует */ }
  }
  return false;
}

async function api(pathname, options = {}, cookie = "") {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(options.headers || {}) },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = text; }
  return { status: r.status, body, headers: r.headers };
}

function uidSet(archive) {
  return (archive.people || []).map((p) => p.uid).filter(Boolean).sort();
}
function names(archive) {
  return (archive.people || []).map((p) => p.name).sort();
}

(async () => {
  let child = null;
  const crypto = require("node:crypto");
  const working = path.join(ROOT, "data", "korni.db");
  const hashOf = (f) => (fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null);
  const workingBefore = hashOf(working);
  try {
    const sourceArchive = isDb ? null : JSON.parse(fs.readFileSync(file, "utf8"));
    if (isDb) fs.copyFileSync(file, path.join(temp, "korni.db"));

    child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      env: { ...process.env, DATA_DIR: temp, PORT: String(port), KORNI_PASSWORD: password, ALLOW_NO_PASSWORD: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });

    const up = await waitForServer();
    check("сервер восстановления запустился", up, up ? "" : log.slice(0, 300));
    if (!up) throw new Error("сервер не поднялся");

    const login = await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    check("вход в восстановленную копию", login.status === 200, `status ${login.status}`);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    let restored = null;
    if (isDb) {
      const got = await api("/api/archive", {}, cookie);
      check("снимок базы читается", got.status === 200, `status ${got.status}`);
      restored = got.body;
    } else {
      const put = await api("/api/archive", { method: "PUT", body: JSON.stringify({ baseRev: 1, archive: sourceArchive }) }, cookie);
      check("копия принимается сервером как архив", put.status === 200, `status ${put.status}${put.status !== 200 ? " " + JSON.stringify(put.body).slice(0, 120) : ""}`);
      const got = await api("/api/archive", {}, cookie);
      check("архив читается после записи", got.status === 200, `status ${got.status}`);
      restored = got.body;
    }

    const backupStatus = await api("/api/backup-status", {}, cookie);
    check("версионирование схемы БД активно (user_version)", backupStatus.status === 200 && backupStatus.body && backupStatus.body.schemaVersion >= 3, `v${backupStatus.body?.schemaVersion}`);

    if (restored) {
      const sourceCount = isDb ? null : sourceArchive.people.length;
      check("число людей совпадает", isDb || restored.people.length === sourceCount, `${restored.people.length}${sourceCount != null ? " из " + sourceCount : ""}`);
      if (!isDb) {
        check("имена совпадают", JSON.stringify(names(restored)) === JSON.stringify(names(sourceArchive)));
        check("стабильные идентификаторы (uid) совпадают", JSON.stringify(uidSet(restored)) === JSON.stringify(uidSet(sourceArchive)), `${uidSet(restored).length} uid`);
        const rel = (a) => a.people.map((p) => `${p.id}:${p.father ?? ""}-${p.mother ?? ""}:${(p.spouses || []).join("|")}`).sort();
        check("связи родителей и супругов совпадают", JSON.stringify(rel(restored)) === JSON.stringify(rel(sourceArchive)));
      }
    }

    // Рабочая база не должна измениться: сравниваем отпечаток до и после.
    if (workingBefore) {
      const after = hashOf(working);
      check("рабочая data/korni.db не тронута", after === workingBefore, (after || "").slice(0, 12) + "…");
    }
  } catch (e) {
    check("проверка завершилась без исключения", false, e.message);
  } finally {
    if (child) { child.kill("SIGTERM"); await sleep(400); child.kill("SIGKILL"); }
    fs.rmSync(temp, { recursive: true, force: true });
    if (syntheticDir && fs.existsSync(syntheticDir)) fs.rmSync(syntheticDir, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} проверок пройдено. Файл: ${path.relative(ROOT, file)}`);
    process.exit(failed ? 1 : 0);
  }
})();
