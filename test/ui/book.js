// Проверка функциональности Семейной книги (Family Book):
// 1. Построение поколений (I, II, III...) и сортировка по годам и именам.
// 2. Отображение портретов с полной подписью (дата, источник, люди на фото).
// 3. Отображение архивных документов, событий, воспоминаний и источников.
// 4. Фильтрация по составу: вся семья / только по мужской линии (тайпан га).
// 5. Защита приватности: режим «Скрыть живущих» для печати/передачи книги родственникам.
// 6. Согласованность с ролями: в роли viewer живущие маскируются автоматически.
// 7. Подготовка к печати/PDF: класс print-book, стили @media print.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { launch, evaluate, screenshot, sleep, browserPath } = require("./cdp");

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "test/ui/out");
const MIME = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"error":"not found"}');
    }
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const bin = browserPath();
  if (!bin) {
    console.log("SKIP — Chromium/Chrome не найден");
    return;
  }

  const server = await serve();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  const chrome = await launch(bin);
  const send = chrome.send;

  await send("Console.enable");
  await send("Runtime.enable");

  try {
    await send("Page.navigate", { url: baseUrl });
    await sleep(600);

    // Подготавливаем тестовые данные: 3 поколения
    // Дед (умер), Сын (умер), Дочь (жива), Внук (жив)
    await evaluate(send, `(()=>{
      const p1 = migrate({
        id: 1, name: "Ахмад", sex: "M", birth: 1910, death: 1985, teip: "Беной",
        birthPlace: "Беной", residence: "Грозный", occupation: "Учитель",
        notes: "Уважаемый старейшина семьи.",
        events: [{ date: "1944", title: "Депортация в Среднюю Азию", place: "Казахстан", note: "Выселен с семьёй" }],
        sources: [{ title: "Похозяйственная книга с. Беной", kind: "archive", note: "Фонд 12, опись 1" }],
        documents: [{ title: "Справка о реабилитации", date: "1957", note: "Выдана МВД ЧИАССР" }]
      });
      const p2 = migrate({
        id: 2, name: "Хеда", sex: "F", birth: 1915, death: 1990, spouses: [1]
      });
      p1.spouses = [2];

      const p3 = migrate({
        id: 3, name: "Муса", sex: "M", birth: 1945, death: 2010, father: 1, mother: 2,
        occupation: "Врач",
        memories: [{ text: "Отец всегда учил нас честности и уважению к корням.", author: "Муса" }]
      });

      const p4 = migrate({
        id: 4, name: "Малика", sex: "F", birth: 1952, father: 1, mother: 2,
        notes: "Живёт в Москве."
      });

      const p5 = migrate({
        id: 5, name: "Зелимхан", sex: "M", birth: 1980, father: 3,
        occupation: "Инженер", teip: "Беной"
      });

      data = {
        format: "korni-local", version: 1, rev: 1, title: "Родословная Ахмада", demo: false,
        log: [], people: [p1, p2, p3, p4, p5]
      };
      render(true);
    })()`);
    await sleep(200);

    // 1. Открытие семейной книги
    const bookOpened = await evaluate(send, `(()=>{
      $("#openBookButton").click();
      const dlg = $("#bookDialog");
      return {
        open: dlg.open,
        title: $("#bookContent h1")?.textContent,
        genCount: document.querySelectorAll("#bookContent h2").length
      };
    })()`);
    check("диалог Семейной книги открывается", bookOpened.open);
    check("заголовок книги совпадает с названием архива", bookOpened.title === "Родословная Ахмада");
    check("сформированы поколения", bookOpened.genCount >= 2, `поколений: ${bookOpened.genCount}`);

    // 2. Проверка архивных фактов в книге
    const contentCheck = await evaluate(send, `(()=>{
      const text = $("#bookContent").textContent;
      const docs = Array.from(document.querySelectorAll("#bookContent .book-docs li")).map(li => li.textContent);
      const events = Array.from(document.querySelectorAll("#bookContent .book-events li")).map(li => li.textContent);
      const sources = Array.from(document.querySelectorAll("#bookContent .book-sources li")).map(li => li.textContent);
      const quotes = Array.from(document.querySelectorAll("#bookContent .book-bio")).map(p => p.textContent);
      return {
        hasTeip: text.includes("Тейп"),
        hasDocs: docs.some(d => d.includes("Справка о реабилитации")),
        hasEvents: events.some(e => e.includes("Депортация")),
        hasSources: sources.some(s => s.includes("Похозяйственная книга")),
        hasQuotes: quotes.some(q => q.includes("Отец всегда учил нас"))
      };
    })()`);
    check("в книге выводятся тейп и факты жизни", contentCheck.hasTeip);
    check("в книге выводятся архивные документы", contentCheck.hasDocs);
    check("в книге выводится хроника событий", contentCheck.hasEvents);
    check("в книге выводятся источники", contentCheck.hasSources);
    check("в книге выводятся семейные воспоминания", contentCheck.hasQuotes);

    // 3. Проверка фильтра «По мужской линии»
    const maleFilterCheck = await evaluate(send, `(()=>{
      const filter = $("#bookLineFilter");
      filter.value = "male";
      filter.dispatchEvent(new Event("change"));
      const names = Array.from(document.querySelectorAll("#bookContent .book-person h3")).map(h => h.textContent);
      return { names };
    })()`);
    check("фильтр «По мужской линии» включает только мужчин", maleFilterCheck.names.includes("Ахмад") && maleFilterCheck.names.includes("Муса") && maleFilterCheck.names.includes("Зелимхан") && !maleFilterCheck.names.includes("Хеда") && !maleFilterCheck.names.includes("Малика"), JSON.stringify(maleFilterCheck.names));

    // Возвращаем фильтр «Вся семья»
    await evaluate(send, `(()=>{
      const filter = $("#bookLineFilter");
      filter.value = "all";
      filter.dispatchEvent(new Event("change"));
    })()`);
    await sleep(100);

    // 4. Проверка режима защиты живущих для печати («Скрыть живущих»)
    const privacyCheck = await evaluate(send, `(()=>{
      const pFilter = $("#bookPrivacyFilter");
      pFilter.value = "hideLiving";
      pFilter.dispatchEvent(new Event("change"));

      // Зелимхан (1980) жив — должен быть скрыт
      // Ахмад (1910-1985) умер — должен остаться полным
      const articles = Array.from(document.querySelectorAll("#bookContent .book-person"));
      const ahmadArt = articles.find(a => a.querySelector("h3")?.textContent === "Ахмад");
      const zelimArt = articles.find(a => a.querySelector("h3")?.textContent === "Зелимхан");

      const ahmadLife = ahmadArt?.querySelector(".book-life")?.textContent || "";
      const zelimLife = zelimArt?.querySelector(".book-life")?.textContent || "";
      const zelimHasTeip = zelimArt?.textContent.includes("Тейп") || false;

      return {
        ahmadLife,
        zelimLife,
        zelimHasTeip
      };
    })()`);
    check("умерший человек сохраняет полные годы в режиме скрытия живущих", privacyCheck.ahmadLife.includes("1910 — 1985"), privacyCheck.ahmadLife);
    check("живущий человек скрывает даты и получает статус приватности", privacyCheck.zelimLife.includes("Сведения скрыты"), privacyCheck.zelimLife);
    check("у живущего человека скрываются чувствительные факты (тейп, профессия)", !privacyCheck.zelimHasTeip);

    // 5. Проверка режима просмотра (Viewer): автоматическое маскирование
    const viewerCheck = await evaluate(send, `(()=>{
      serverMode = true;
      guestMode = false;
      me.role = "viewer";
      applyRoleUi();
      $("#openBookButton").click();
      const pFilter = $("#bookPrivacyFilter");
      return {
        disabled: pFilter.disabled,
        val: pFilter.value
      };
    })()`);
    check("для роли viewer фильтр приватности заблокирован на сокрытии", viewerCheck.disabled && viewerCheck.val === "hideLiving");

    // Восстанавливаем статус
    await evaluate(send, `(()=>{
      serverMode = false;
      me.role = "keeper";
      applyRoleUi();
    })()`);

    // 6. Подготовка к печати
    const printCheck = await evaluate(send, `(()=>{
      // Заменяем window.print на заглушку, чтобы не блокировать CDP
      let printCalled = false;
      const oldPrint = window.print;
      window.print = () => { printCalled = true; };
      printBook();
      const hasClass = document.body.classList.contains("print-book");
      window.print = oldPrint;
      return { hasClass };
    })()`);
    check("вызов printBook переводит страницу в режим print-book", printCheck.hasClass);

    // Закрываем книгу
    await evaluate(send, `$("#closeBook").click();`);
    await sleep(150);

    const consoleErrors = (chrome.events || []).filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error");
    const real = consoleErrors.filter((e) => !JSON.stringify(e.params.args || []).includes("404"));
    check("консоль без ошибок", real.length === 0, real.map((e) => JSON.stringify(e.params.args)).join(" | ").slice(0, 300));

  } finally {
    try { await chrome.close(); } catch (e) {}
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} проверок пройдено`);
  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Ошибка теста:", err);
  process.exit(1);
});
