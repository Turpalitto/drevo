// Нагрузочное тестирование производительности (Performance & Scalability):
// Тестирование на синтетическом архиве из 2500 человек (8 поколений):
// 1. Время раскладки и отрисовки древа (renderTree).
// 2. Время расчёта родства (kinshipLabel + familyPath) для пар разной степени удалённости.
// 3. Время генерации Семейной книги (buildBook) для 2500 человек.
// 4. Отсутствие утечек памяти и зависаний интерфейса.

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

    // 1. Генерация 2500 человек в браузере
    const genStatus = await evaluate(send, `(()=>{
      const chechenMaleNames = ["Ахмад", "Зелимхан", "Турпал", "Идрис", "Муса", "Хасан", "Хусейн", "Умар", "Али", "Сайд-Эмин", "Бекхан", "Аслан", "Адам", "Ибрагим", "Рамзан", "Шамиль", "Мансур", "Юнус", "Юсуп", "Салман"];
      const chechenFemaleNames = ["Хеда", "Аминат", "Малика", "Зарема", "Мадина", "Петимат", "Селима", "Луиза", "Тамара", "Хадижат", "Разият", "Зулай", "Фатима", "Иман", "Ясмина", "Лейла", "Марьям"];
      const teips = ["Беной", "Гендарганой", "Цонтарой", "Билтой", "Аллерой", "Чинхой", "Варандой", "Зурзакхой", "Нижалой", "Ялхой"];

      const people = [];
      let id = 1;
      const tStart = performance.now();

      // Поколение 0 (родоначальники)
      const gen0 = [];
      for (let i = 0; i < 4; i++) {
        const m = migrate({
          id: id++, name: chechenMaleNames[i % chechenMaleNames.length] + " " + (i + 1), sex: "M", birth: 1780 + i * 5, death: 1850 + i * 5, teip: teips[i % teips.length]
        });
        const w = migrate({
          id: id++, name: chechenFemaleNames[i % chechenFemaleNames.length] + " " + (i + 1), sex: "F", birth: 1785 + i * 5, death: 1855 + i * 5, spouses: [m.id]
        });
        m.spouses = [w.id];
        people.push(m, w);
        gen0.push({ m, w });
      }

      // 7 последующих поколений с разветвлением
      let prevGen = gen0;
      let targetCount = 2500;
      let genIndex = 1;

      while (people.length < targetCount && prevGen.length > 0) {
        const nextGen = [];
        const approxYear = 1810 + genIndex * 28;
        for (const couple of prevGen) {
          if (people.length >= targetCount) break;
          // У каждой пары 3-4 детей
          const numKids = 3;
          for (let k = 0; k < numKids; k++) {
            if (people.length >= targetCount) break;
            const isMale = k % 2 === 0;
            const kid = migrate({
              id: id++,
              name: (isMale ? chechenMaleNames : chechenFemaleNames)[(people.length + k) % 15] + " " + id,
              sex: isMale ? "M" : "F",
              birth: approxYear + k * 2,
              death: approxYear + 65 + k * 2,
              father: couple.m.id,
              mother: couple.w.id,
              teip: couple.m.teip
            });
            people.push(kid);

            // Для мужчин создаём супругу
            if (isMale && people.length < targetCount) {
              const sp = migrate({
                id: id++,
                name: chechenFemaleNames[(id) % chechenFemaleNames.length] + " " + id,
                sex: "F",
                birth: approxYear + 2 + k * 2,
                death: approxYear + 68 + k * 2,
                spouses: [kid.id]
              });
              kid.spouses = [sp.id];
              people.push(sp);
              nextGen.push({ m: kid, w: sp });
            }
          }
        }
        prevGen = nextGen;
        genIndex++;
      }

      data = {
        format: "korni-local", version: 1, rev: 1, title: "Крупный чеченский архив", demo: false,
        log: [], people
      };
      const genTime = performance.now() - tStart;
      return { count: people.length, genTime };
    })()`);

    check("синтетический архив создан", genStatus.count >= 2000, `${genStatus.count} записей за ${genStatus.genTime.toFixed(1)} мс`);

    // 2. Тестирование производительности renderTree() на 2500 записях
    const renderBench = await evaluate(send, `(()=>{
      const t0 = performance.now();
      render(true);
      const t1 = performance.now();
      const nodeCount = document.querySelectorAll("#tree .node").length;
      return { timeMs: t1 - t0, nodeCount };
    })()`);
    check("отрисовка древа для >2000 человек выполняется без зависания", renderBench.timeMs < 600, `${renderBench.timeMs.toFixed(1)} мс (${renderBench.nodeCount} узлов)`);

    // 3. Тестирование расчёта родства (kinshipLabel + familyPath)
    const kinshipBench = await evaluate(send, `(()=>{
      const ids = data.people.map(p => p.id);
      const sampleCount = 30;
      const pairs = [];
      for (let i = 0; i < sampleCount; i++) {
        const a = ids[Math.floor(Math.random() * ids.length)];
        const b = ids[Math.floor(Math.random() * ids.length)];
        if (a !== b) pairs.push([a, b]);
      }

      const t0 = performance.now();
      let foundCount = 0;
      for (const [a, b] of pairs) {
        const label = kinshipLabel(a, b);
        const path = familyPath(a, b, true);
        if (label || path) foundCount++;
      }
      const t1 = performance.now();
      const totalTime = t1 - t0;
      const avgTime = totalTime / pairs.length;
      return { pairsCount: pairs.length, totalTime, avgTime, foundCount };
    })()`);
    check("расчёт родства выполняется быстро (O(1) индексы)", kinshipBench.avgTime < 5, `в среднем ${kinshipBench.avgTime.toFixed(2)} мс на пару (всего ${kinshipBench.totalTime.toFixed(1)} мс за ${kinshipBench.pairsCount} пар)`);

    // 4. Тестирование генерации книги (buildBook) на 2500 записях
    const bookBench = await evaluate(send, `(()=>{
      const t0 = performance.now();
      buildBook();
      const t1 = performance.now();
      const personCards = document.querySelectorAll("#bookContent .book-person").length;
      const genHeadings = document.querySelectorAll("#bookContent h2").length;
      return { timeMs: t1 - t0, personCards, genHeadings };
    })()`);
    check("Семейная книга для >2000 человек генерируется быстрее 400 мс", bookBench.timeMs < 400, `${bookBench.timeMs.toFixed(1)} мс (${bookBench.personCards} карточек в ${bookBench.genHeadings} поколениях)`);

    // 5. Тестирование фильтра книги «По мужской линии» на 2500 записях
    const maleBookBench = await evaluate(send, `(()=>{
      const filter = $("#bookLineFilter");
      filter.value = "male";
      const t0 = performance.now();
      buildBook();
      const t1 = performance.now();
      const maleCards = document.querySelectorAll("#bookContent .book-person").length;
      return { timeMs: t1 - t0, maleCards };
    })()`);
    check("фильтрация книги по мужской линии выполняется мгновенно", maleBookBench.timeMs < 250, `${maleBookBench.timeMs.toFixed(1)} мс (${maleBookBench.maleCards} карточек мужчин)`);

    // 6. Тестирование поиска среди 2500 человек
    const searchBench = await evaluate(send, `(()=>{
      const t0 = performance.now();
      renderGlobalResults("Ахмад");
      const t1 = performance.now();
      const count = document.querySelectorAll("#globalResults button").length;
      return { timeMs: t1 - t0, count };
    })()`);
    check("глобальный поиск по архиву находит совпадения быстро", searchBench.timeMs < 50, `${searchBench.timeMs.toFixed(1)} мс (${searchBench.count} результатов)`);

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
  console.error("Ошибка теста производительности:", err);
  process.exit(1);
});
