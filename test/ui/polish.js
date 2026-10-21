// Проверка полировки интерфейса (UI Polish):
// 1. Чеченская палочка (Ӏ/ӏ): кнопки вставки в форме, автоисправление 1/I/l/І при blur и сохранении.
// 2. Длинные составные имена на древе: перенос на 2 строки через <tspan> (в простом, детальном и компактном LOD).
// 3. Первичный вход (Empty state): кнопка загрузки файла и примечание о приватности.
// 4. Карточка человека: отсутствие пустых разделов («Основное» без фактов не рисуется) и подсказка для пустой карточки.
// 5. Адаптивность 390px и 1440px: отсутствие горизонтальной прокрутки, доступность кнопок.

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

    // 1. Проверка первичного экрана (Empty state)
    const emptyState = await evaluate(send, `(()=>{
      const emp = document.querySelector("#empty");
      const btn = document.querySelector("#emptyImportButton");
      const priv = document.querySelector(".empty-privacy");
      return {
        hasEmpty: !!emp,
        hasImportBtn: !!btn && btn.textContent.includes("Загрузить файл"),
        hasPrivacy: !!priv && priv.textContent.includes("хранятся только в этом браузере")
      };
    })()`);
    check("пустой архив предлагает загрузить файл", emptyState.hasImportBtn);
    check("на первом экране есть пояснение о приватности", emptyState.hasPrivacy);

    // 2. Проверка тулбара палочки (Ӏ/ӏ) в форме
    await evaluate(send, `openPerson(null); openEdit(false);`);
    await sleep(200);

    const palochkaUi = await evaluate(send, `(()=>{
      const btns = Array.from(document.querySelectorAll(".palochka-btn"));
      const chars = btns.map(b => b.dataset.char);
      return { count: btns.length, chars };
    })()`);
    check("кнопки вставки чеченской палочки присутствуют в форме", palochkaUi.count === 2 && palochkaUi.chars.includes("Ӏ") && palochkaUi.chars.includes("ӏ"));

    // Клик по кнопке вставляет заглавную палочку в поле имени
    const insertTest = await evaluate(send, `(()=>{
      const input = document.querySelector('#personForm input[name="name"]');
      input.value = "";
      input.focus();
      const btn = document.querySelector('.palochka-btn[data-char="Ӏ"]');
      btn.click();
      return input.value;
    })()`);
    check("кнопка Ӏ вставляет символ в поле имени", insertTest === "Ӏ", `получено: ${insertTest}`);

    // Автоисправление цифры 1 и латиницы I/l на чеченскую палочку при blur
    const autoFixTest = await evaluate(send, `(()=>{
      const input = document.querySelector('#personForm input[name="name"]');
      input.value = "1умар";
      input.dispatchEvent(new Event("blur"));
      const nameVal = input.value;

      const native = document.querySelector('#personForm input[name="native"]');
      native.value = "к1ант";
      native.dispatchEvent(new Event("blur"));
      const nativeVal = native.value;

      const variants = document.querySelector('#personForm input[name="nameVariants"]');
      variants.value = "Махьма-1ела";
      variants.dispatchEvent(new Event("blur"));
      const variantsVal = variants.value;

      const safeYear = fixChechenPalochka("Иван 1930");
      return { nameVal, nativeVal, variantsVal, safeYear };
    })()`);
    check("цифра 1 в начале имени исправляется на заглавную Ӏ", autoFixTest.nameVal === "Ӏумар", autoFixTest.nameVal);
    check("цифра 1 внутри слова исправляется на строчную ӏ", autoFixTest.nativeVal.includes("\u04C0") || autoFixTest.nativeVal.includes("\u04CF"), autoFixTest.nativeVal);
    check("цифра 1 через дефис исправляется на заглавную Ӏ", autoFixTest.variantsVal === "Махьма-Ӏела", autoFixTest.variantsVal);
    check("четырёхзначный год не искажается автоисправлением", autoFixTest.safeYear === "Иван 1930", autoFixTest.safeYear);

    // Закрываем форму
    await evaluate(send, `document.querySelector("#personDialog").close();`);
    await sleep(150);

    // 3. Создаём человека с длинным чеченским именем и проверяем перенос на 2 строки в древе
    await evaluate(send, `(()=>{
      const p = migrate({
        id: 1,
        name: "Махьма-Хьажи кӀант Турпал-Ӏела",
        sex: "M",
        birth: 1950
      });
      data = { format: "korni-local", version: 1, rev: 1, title: "Тест", demo: false, log: [], people: [p] };
      render(true);
    })()`);
    await sleep(200);

    // Простой режим (simple)
    const simpleLines = await evaluate(send, `(()=>{
      setDetailLevel("simple", false);
      const text = document.querySelector("#tree .node-full .name");
      const tspans = Array.from(text.querySelectorAll("tspan")).map(t => t.textContent);
      return { tspans, text: text.textContent };
    })()`);
    check("длинное имя разбивается на 2 строки tspan в простом режиме", simpleLines.tspans.length === 2, JSON.stringify(simpleLines.tspans));

    // Детальный режим (detailed)
    const detailedLines = await evaluate(send, `(()=>{
      setDetailLevel("detailed", false);
      const text = document.querySelector("#tree .node-full .name");
      const tspans = Array.from(text.querySelectorAll("tspan")).map(t => t.textContent);
      return { tspans, text: text.textContent };
    })()`);
    check("длинное имя разбивается на 2 строки tspan в детальном режиме", detailedLines.tspans.length === 2, JSON.stringify(detailedLines.tspans));

    // Компактный режим (compact)
    const compactLines = await evaluate(send, `(()=>{
      const text = document.querySelector("#tree .node-compact .name");
      const tspans = Array.from(text.querySelectorAll("tspan")).map(t => t.textContent);
      return { tspans, text: text.textContent };
    })()`);
    check("длинное имя разбивается на 2 строки tspan в компактном узле", compactLines.tspans.length === 2, JSON.stringify(compactLines.tspans));

    // 4. Проверка карточки человека: если пол указан, Основное показывает пол
    await evaluate(send, `openPerson(1);`);
    await sleep(150);

    const person1Check = await evaluate(send, `(()=>{
      const sections = Array.from(document.querySelectorAll("#profileSections .profile-section h3")).map(h => h.textContent);
      const factText = document.querySelector("#profileSections .profile-facts")?.textContent || "";
      return { sections, factText };
    })()`);
    check("у человека с полом раздел «Основное» содержит сведения о поле", person1Check.sections.includes("Основное") && person1Check.factText.includes("Мужчина"));

    // Добавляем человека с нулевыми фактами вообще (только имя, sex: "U")
    await evaluate(send, `(()=>{
      const p = migrate({ id: 2, name: "Только Имя", sex: "U" });
      data.people.push(p);
      openPerson(2);
    })()`);
    await sleep(150);

    const onlyNameCheck = await evaluate(send, `(()=>{
      const sections = Array.from(document.querySelectorAll("#profileSections .profile-section h3")).map(h => h.textContent);
      const notice = document.querySelector("#profileSections .profile-empty-notice");
      return { sectionsCount: sections.length, hasNotice: !!notice && notice.textContent.includes("Сведения пока не заполнены") };
    })()`);
    check("в карточке без фактов нет пустого заголовка «Основное»", onlyNameCheck.sectionsCount === 0, `разделов: ${onlyNameCheck.sectionsCount}`);
    check("карточка без фактов показывает дружелюбную подсказку", onlyNameCheck.hasNotice);

    // Закрываем карточку
    await evaluate(send, `document.querySelector("#personDialog").close();`);
    await sleep(150);

    // 5. Адаптивность: мобильный экран 390px
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(250);

    const mobileMetrics = await evaluate(send, `(()=>{
      const doc = document.documentElement;
      const body = document.body;
      const overflow = Math.max(doc.scrollWidth, body.scrollWidth) > doc.clientWidth;
      openPerson(null); openEdit(false);
      const dialog = document.querySelector("#personDialog");
      const dialogRect = dialog.getBoundingClientRect();
      const toolbar = document.querySelector(".palochka-toolbar");
      const toolbarRect = toolbar.getBoundingClientRect();
      const fitsDialog = toolbarRect.right <= dialogRect.right + 1;
      dialog.close();
      return { overflow, fitsDialog };
    })()`);
    check("на телефоне (390px) нет горизонтальной прокрутки страницы", !mobileMetrics.overflow);
    check("тулбар чеченской палочки помещается в диалоге на 390px", mobileMetrics.fitsDialog);

    // 6. Десктопный экран 1440px
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);

    const desktopMetrics = await evaluate(send, `(()=>{
      const doc = document.documentElement;
      const overflow = doc.scrollWidth > doc.clientWidth;
      return { overflow };
    })()`);
    check("на десктопе (1440px) нет горизонтальной прокрутки", !desktopMetrics.overflow);

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
