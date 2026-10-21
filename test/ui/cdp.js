// Минимальный CDP-мост к chrome-headless-shell без внешних зависимостей.
// Путь к браузеру можно задать переменной KORNI_CHROME; иначе берётся
// стандартный кэш Playwright. Если браузера нет — тест помечается пропущенным.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CANDIDATES = [
  process.env.KORNI_CHROME,
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function browserPath() {
  return CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const bin = browserPath();
  if (!bin) throw new Error("браузер не найден: задайте KORNI_CHROME");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-chrome-"));
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    "--no-first-run", "--no-default-browser-check",
    // В песочнице GPU-процесс не поднимается и браузер падает: отключаем его.
    "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu",
    "--disable-gpu", "--hide-scrollbars",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let info = null;
  for (let i = 0; i < 100; i++) {
    await sleep(120);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(800)});
      if (r.ok) { info = await r.json(); break; }
    } catch (e) { /* ещё не поднялся */ }
  }
  if (!info) { child.kill("SIGKILL"); throw new Error("браузер не запустился"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  return {
    child, ws, send, events, sleep,
    close: async () => {
      try { ws.close(); } catch (e) {}
      try { child.kill("SIGKILL"); } catch (e) {}
      await sleep(100);
      try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) {}
    },
  };
}

async function evaluate(send, expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function screenshot(send, file, width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await sleep(350);
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
}

module.exports = { launch, evaluate, screenshot, sleep, browserPath };
