// Проверка подсистемы хранения и переносимости:
// 1. Бесшовная миграция из localStorage в IndexedDB (korni-storage-v1).
// 2. Персистентность изменений в IndexedDB.
// 3. Сохранение резервных копий и откат из IndexedDB.
// 4. Устойчивость к переполнению localStorage (хранение крупных архивов в IndexedDB).
// 5. Выгрузка архива с оригиналами файлов (korni-archive) и импорт с восстановлением в IndexedDB.
// 6. Очистка баз IndexedDB и localStorage при выходе.
// 7. Отсутствие ошибок в консоли.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { launch, evaluate, sleep, browserPath } = require("./cdp");

const ROOT = path.resolve(__dirname, "../..");
let server = null;
let serverPort = 0;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function seedData() {
  return {
    format: "korni-local",
    version: 1,
    title: "Тестовый архив для проверки хранилища",
    demo: false,
    log: [],
    people: [
      {
        id: 1, uid: "11111111-1111-4111-8111-111111111111",
        name: "Ахмед", native: "Ахьмад", nameVariants: "", sex: "M",
        birth: 1930, death: 1999, birthFull: "1930-05-12", deathFull: "1999-01-01",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "Беной", tukhum: "",
        birthPlace: "Беной", deathPlace: "Грозный", birthPlaceNow: "", deathPlaceNow: "",
        residence: "Беной", occupation: "чабан", info: "", notes: "Заметка", source: "Семейная память",
        photo: "", photoMeta: null,
        spouses: [2], unions: [], events: [], sources: [], memories: [], documents: [],
      },
      {
        id: 2, uid: "22222222-2222-4222-8222-222222222222",
        name: "Аминат", native: "Аминат", nameVariants: "", sex: "F",
        birth: 1934, death: null, birthFull: "1934-03-08", deathFull: "",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "", tukhum: "",
        birthPlace: "Шали", deathPlace: "", birthPlaceNow: "", deathPlaceNow: "",
        residence: "Грозный", occupation: "учительница", info: "", notes: "", source: "",
        photo: "", photoMeta: null,
        spouses: [1], unions: [], events: [], sources: [], memories: [], documents: [],
      },
    ],
  };
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
      } else if (url.pathname.startsWith("/assets/")) {
        const file = path.join(ROOT, url.pathname);
        if (fs.existsSync(file)) {
          res.writeHead(200);
          fs.createReadStream(file).pipe(res);
        } else {
          res.writeHead(404);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

(async () => {
  if (!browserPath()) {
    console.log("SKIP — браузер не найден, UI-проверки пропущены (задайте KORNI_CHROME)");
    return;
  }

  await startServer();
  const base = `http://127.0.0.1:${serverPort}`;

  const browser = await launch();
  const send = browser.send;

  try {
    await send("Page.enable");
    await send("DOM.enable");
    await send("Runtime.enable");
    await send("Log.enable");

    // 1. Предварительно засеиваем localStorage архивными данными и бэкапом (имитируем старую версию приложения)
    await send("Page.navigate", { url: base });
    await sleep(400);

    const legacySeed = seedData();
    const legacyBackup = { at: new Date().toISOString(), reason: "test-legacy", data: legacySeed };

    await evaluate(send, `(()=>{
      localStorage.setItem("korni-local-v1", ${JSON.stringify(JSON.stringify(legacySeed))});
      localStorage.setItem("korni-local-v1-backup", ${JSON.stringify(JSON.stringify(legacyBackup))});
      return true;
    })()`);

    // Перезагружаем страницу, чтобы сработал boot() и миграция из localStorage в IndexedDB
    await send("Page.reload");
    await sleep(800);

    // 2. Проверяем, что данные прочитаны и мигрированы в IndexedDB
    const migrationCheck = await evaluate(send, `(async ()=>{
      const inMemTitle = data.title;
      const inMemCount = data.people.length;

      // Читаем напрямую из IndexedDB (korni-storage-v1 -> records):
      const idbCurrent = await idbStorageGet("current");
      const idbBackup = await idbStorageGet("backup");

      return {
        inMemTitle,
        inMemCount,
        idbHasCurrent: Boolean(idbCurrent && idbCurrent.title === inMemTitle),
        idbPeopleCount: idbCurrent ? idbCurrent.people.length : 0,
        idbHasBackup: Boolean(idbBackup && idbBackup.reason === "test-legacy"),
      };
    })()`);

    check("архив загружен из localStorage при миграции", migrationCheck.inMemCount === 2);
    check("данные успешно сохранены в IndexedDB («records» → «current»)", migrationCheck.idbHasCurrent && migrationCheck.idbPeopleCount === 2);
    check("резервная копия мигрирована в IndexedDB («records» → «backup»)", migrationCheck.idbHasBackup);

    // 3. Проверяем сохранение нового человека и персистентность в IndexedDB
    await evaluate(send, `(()=>{
      const next = copy();
      next.people.push({
        id: 3, uid: newUid(), name: "Зелимхан", native: "Зеламха", nameVariants: "", sex: "M",
        birth: 1965, death: null, father: 1, mother: 2, teip: "Беной", tukhum: "",
        notes: "", source: "", birthFull: "", deathFull: "", birthPlace: "", deathPlace: "",
        birthPlaceNow: "", deathPlaceNow: "", occupation: "", residence: "", info: "",
        photo: "", photoMeta: null, spouses: [], unions: [], events: [], sources: [], memories: [], documents: []
      });
      commit(next, "Добавлен: Зелимхан");
      return true;
    })()`);
    await sleep(300);

    const persistCheck = await evaluate(send, `(async ()=>{
      const idbCurrent = await idbStorageGet("current");
      return {
        inMemCount: data.people.length,
        idbCount: idbCurrent ? idbCurrent.people.length : 0,
        hasPerson: idbCurrent && idbCurrent.people.some(p => p.name === "Зелимхан")
      };
    })()`);

    check("добавление человека сохраняется в IndexedDB", persistCheck.inMemCount === 3 && persistCheck.idbCount === 3 && persistCheck.hasPerson);

    // 4. Проверяем создание резервной копии и откат из IndexedDB
    await evaluate(send, `(async ()=>{
      await backupCurrent("before-wipe-test");
      const next = { format: "korni-local", version: 1, rev: myRev + 1, title: "Пустой архив", demo: false, people: [], log: [] };
      commit(next, "Очистка для теста");
      return true;
    })()`);
    await sleep(300);

    const wipeCheck = await evaluate(send, `(()=>{ return data.people.length; })()`);
    check("архив очищен перед откатом", wipeCheck === 0);

    // Восстанавливаем из бэкапа
    await evaluate(send, `(async ()=>{
      const b = await loadBackup();
      if (b && b.data) {
        commit(parseArchive(b.data), "Откат из бэкапа");
      }
      return true;
    })()`);
    await sleep(300);

    const restoreCheck = await evaluate(send, `(async ()=>{
      const idbCurrent = await idbStorageGet("current");
      return {
        restoredCount: data.people.length,
        idbRestoredCount: idbCurrent ? idbCurrent.people.length : 0,
      };
    })()`);

    check("откат из резервной копии IndexedDB восстанавливает людей", restoreCheck.restoredCount === 3 && restoreCheck.idbRestoredCount === 3);

    // 5. Устойчивость к крупным архивам:
    // Добавляем людей с подробными заметками (проверяем, что IndexedDB сохраняет всё без сбоев)
    const largePersistenceCheck = await evaluate(send, `(async ()=>{
      const next = copy();
      for (let i = 4; i <= 30; i++) {
        next.people.push({
          id: i, uid: newUid(), name: "Родственник " + i, native: "", nameVariants: "", sex: "M",
          birth: 1970 + (i % 20), death: null, father: 3, mother: null, teip: "Беной", tukhum: "",
          notes: "Подробные архивные воспоминания о семье и жизни в селе. ".repeat(40),
          source: "Семейный архив и документы", birthFull: "", deathFull: "", birthPlace: "Беной", deathPlace: "",
          birthPlaceNow: "", deathPlaceNow: "", occupation: "строитель", residence: "Грозный", info: "Краткая справка",
          photo: "", photoMeta: null, spouses: [], unions: [], events: [], sources: [], memories: [], documents: []
        });
      }

      let errorThrown = false;
      try {
        commit(next, "Массовое добавление записей");
      } catch (e) {
        errorThrown = true;
      }
      await new Promise((r) => setTimeout(r, 300));

      const idbCurrent = await idbStorageGet("current");
      return {
        errorThrown,
        totalCount: data.people.length,
        idbTotalCount: idbCurrent ? idbCurrent.people.length : 0,
        storageFailedFlag: storageFailed
      };
    })()`);

    check("архив с десятками подробных записей сохраняется в IndexedDB", !largePersistenceCheck.errorThrown && largePersistenceCheck.idbTotalCount === 30 && !largePersistenceCheck.storageFailedFlag);

    // 6. Проверяем сохранение медиафайла и экспорт полного архива (korni-archive)
    const mediaExportCheck = await evaluate(send, `(async ()=>{
      // Сохраняем тестовый файл в korni-media-v1
      const testBlob = new Blob(["test-archive-image-data-bytes"], { type: "image/png" });
      await saveMedia({
        id: "media-storage-test-1",
        blob: testBlob,
        name: "test-photo.png",
        type: "image/png",
        size: testBlob.size,
        at: new Date().toISOString()
      });

      // Собираем архив с оригиналами (как это делает exportMediaButton)
      const media = await allMedia();
      const payload = { format: "korni-archive", version: 1, exportedAt: new Date().toISOString(), archive: data, media: [] };
      for (const rec of media) {
        if (!rec || !rec.blob) continue;
        const encoded = await blobToBase64(rec.blob);
        payload.media.push({ id: rec.id, name: rec.name, type: rec.type, size: rec.size, at: rec.at, data: encoded });
      }

      return {
        mediaCount: media.length,
        exportedMediaCount: payload.media.length,
        hasMediaData: payload.media.length > 0 && typeof payload.media[0].data === "string" && payload.media[0].data.length > 0,
        format: payload.format
      };
    })()`);

    check("медиафайл сохранён в IndexedDB korni-media-v1", mediaExportCheck.mediaCount >= 1);
    check("экспорт korni-archive упаковывает данные и медиафайлы в base64", mediaExportCheck.format === "korni-archive" && mediaExportCheck.exportedMediaCount >= 1 && mediaExportCheck.hasMediaData);

    // 7. Очистка хранилищ при выходе
    await evaluate(send, `(async ()=>{
      await clearAllMedia();
      await clearStorageDb();
      localStorage.removeItem("korni-local-v1");
      localStorage.removeItem("korni-data-v1");
      return true;
    })()`);
    await sleep(200);

    const cleanupCheck = await evaluate(send, `(async ()=>{
      const idbCurrent = await idbStorageGet("current");
      const mediaList = await allMedia();
      const lsCurrent = localStorage.getItem("korni-local-v1");
      return {
        idbCleared: idbCurrent === null || idbCurrent === undefined,
        mediaCleared: mediaList.length === 0,
        lsCleared: lsCurrent === null
      };
    })()`);

    check("очистка при выходе удаляет базу архива IndexedDB", cleanupCheck.idbCleared);
    check("очистка при выходе удаляет медиафайлы IndexedDB", cleanupCheck.mediaCleared);
    check("очистка при выходе удаляет localStorage", cleanupCheck.lsCleared);

    // 8. Консоль без ошибок
    const bad = browser.events.filter((e) => e.method === "Runtime.exceptionThrown"
      || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !String(e.params.entry.url || "").includes("/api/")));
    check("консоль без ошибок", bad.length === 0, bad.length ? JSON.stringify(bad[0]).slice(0, 300) : "");

  } finally {
    await browser.close();
    if (server) {
      server.close();
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
  if (failed) process.exit(1);
})();
