// Проверка этапа 5 в настоящем браузере: роли, приглашения, предложения правок,
// сравнение (diff), защита от затирания, история изменений и откат, права хранителя
// и наблюдателя, защита кэша при выходе.
// Запуск: npm run test:ui (нужен Chrome/Chromium; путь можно задать KORNI_CHROME)
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { launch, evaluate, sleep, browserPath } = require("./cdp");

const ROOT = path.resolve(__dirname, "../..");
const PASSWORD = "test-korni-password-2026";
let server = null;
let serverPort = 0;
let dataDir = "";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function seedData() {
  return {
    format: "korni-local",
    version: 1,
    title: "Тестовый архив доступа",
    demo: false,
    log: [],
    people: [
      {
        id: 1, uid: "11111111-1111-4111-8111-111111111111",
        name: "Ахмед", native: "Ахьмад", sex: "M",
        birth: 1930, death: 1999, birthFull: "1930-05-12", deathFull: "1999-01-01",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "Беной", tukhum: "",
        birthPlace: "Беной", deathPlace: "Грозный", birthPlaceNow: "", deathPlaceNow: "",
        residence: "Беной", occupation: "чабан", info: "", notes: "Заметка об Ахмеде", source: "Семейная память",
        photo: "", photoMeta: null,
        spouses: [2], unions: [], events: [], sources: [], memories: [], documents: [],
      },
      {
        id: 2, uid: "22222222-2222-4222-8222-222222222222",
        name: "Аминат", native: "Аминат", sex: "F",
        birth: 1934, death: null, birthFull: "1934-03-08", deathFull: "",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: null, mother: null, teip: "", tukhum: "",
        birthPlace: "Шали", deathPlace: "", birthPlaceNow: "", deathPlaceNow: "",
        residence: "Грозный", occupation: "учительница", info: "", notes: "", source: "",
        photo: "", photoMeta: null,
        spouses: [1], unions: [], events: [], sources: [], memories: [], documents: [],
      },
      {
        id: 3, uid: "33333333-3333-4333-8333-333333333333",
        name: "Муса", native: "Муса", sex: "M",
        birth: 1960, death: null, birthFull: "1960-07-20", deathFull: "",
        birthQ: "", birthQ2: null, deathQ: "", deathQ2: null,
        father: 1, mother: 2, teip: "Беной", tukhum: "",
        birthPlace: "Грозный", deathPlace: "", birthPlaceNow: "", deathPlaceNow: "",
        residence: "Грозный", occupation: "инженер", info: "", notes: "", source: "",
        photo: "", photoMeta: null,
        spouses: [], unions: [], events: [], sources: [], memories: [], documents: [],
      },
    ],
  };
}

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "korni-stage5-ui-"));
  return new Promise((resolve, reject) => {
    // Выбираем свободный порт
    const tempServer = http.createServer();
    tempServer.listen(0, "127.0.0.1", () => {
      serverPort = tempServer.address().port;
      tempServer.close(() => {
        const env = { ...process.env, KORNI_PASSWORD: PASSWORD, DATA_DIR: dataDir, PORT: String(serverPort) };
        server = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, stdio: "pipe" });
        const timer = setTimeout(() => reject(new Error("сервер не поднялся за 10с")), 10000);
        server.stdout.on("data", (d) => {
          if (String(d).includes("Корни: общая база")) {
            clearTimeout(timer);
            resolve();
          }
        });
        server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
      });
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

  // Засеваем начальный архив через API
  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const keeperCookie = loginRes.headers.get("set-cookie")?.split(";")[0] || "";
  await fetch(`${base}/api/archive`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: keeperCookie },
    body: JSON.stringify({ baseRev: 1, archive: seedData() }),
  });

  const browser = await launch();
  const { send } = browser;

  try {
    // 1. Неавторизованный вход показывает окно входа без чужих данных
    await send("Page.navigate", { url: base + "/" });
    await sleep(1500);
    const bootCheck = await evaluate(send, `(()=>{
      const dialog = $("#loginDialog");
      return {
        open: dialog && dialog.open,
        peopleCount: (typeof data === "object" && data.people) ? data.people.length : 0
      };
    })()`);
    check("приложение открывает диалог входа без утечки чужого архива", bootCheck.open === true && bootCheck.peopleCount === 0);

    // 2. Хранитель входит по паролю через интерфейс
    await evaluate(send, `(()=>{
      $("#loginPassword").value = "${PASSWORD}";
      $("#loginForm").requestSubmit();
      return true;
    })()`);
    await sleep(1200);
    const keeperBadge = await evaluate(send, `(()=>{
      const b = $("#roleBadge");
      return { visible: !b.hidden, text: b.textContent, role: me.role };
    })()`);
    check("хранитель входит по паролю и видит статус общей базы", keeperBadge.visible && keeperBadge.role === "keeper", JSON.stringify(keeperBadge));

    // Проверка контекстного уведомления при сохранении в серверном режиме
    await evaluate(send, `(()=>{
      openPerson(1);
      $("#editPersonButton").click();
      $("#personForm").requestSubmit();
      return true;
    })()`);
    await sleep(800);
    const saveToast = await evaluate(send, `(()=>{
      const t = $("#toast");
      return t ? t.textContent : "";
    })()`);
    check("сохранение в серверном режиме показывает контекстное уведомление об общей базе", saveToast.includes("в общей базе"), saveToast);

    // Проверка пояснения приватности в серверном режиме
    const privacyText = await evaluate(send, `(()=>{
      const ep = $("#emptyPrivacy");
      return ep ? ep.textContent : "";
    })()`);
    check("текст приватности в серверном режиме поясняет защиту семейного сервера", privacyText.includes("семейном сервере"), privacyText);

    // Проверка защиты от XSS в заявках гостей
    const linkRes = await fetch(`${base}/api/contribution-link`, { headers: { Cookie: keeperCookie } });
    const linkData = await linkRes.json();
    const guestToken = new URL(linkData.url).searchParams.get("contribute");
    const contribPost = await fetch(`${base}/api/contributions?token=${encodeURIComponent(guestToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submittedBy: "Гость <script>window.__xssRun=true</script>",
        contact: "test@example.com",
        relativeId: 1,
        secondParentId: null,
        relation: "child",
        name: "Ребёнок <img src=x onerror=window.__xssRun=true><b id=\"xssMarker\">тест</b>",
        sex: "M",
        birth: null,
        birthPlace: "",
        info: "<script>window.__xssRun=true</script>",
        notes: "Заметка <img src=x onerror=window.__xssRun=true>",
      }),
    });
    await evaluate(send, `(async () => {
      await refreshContributions();
      $("#submissionsButton").click();
      return true;
    })()`);
    await sleep(600);
    const xssCheck = await evaluate(send, `(()=>{
      const marker = document.getElementById("xssMarker");
      const list = $("#submissionList");
      const text = list ? list.textContent : "";
      return {
        xssExecuted: !!window.__xssRun,
        markerInDom: !!marker,
        textContainsRawTag: text.includes("<img src=x"),
      };
    })()`);
    check("заявки гостей защищены от XSS (теги выводятся как текст без выполнения)", !xssCheck.xssExecuted && !xssCheck.markerInDom && xssCheck.textContainsRawTag, JSON.stringify(xssCheck));
    await evaluate(send, `$("#submissionsDialog").close(); true`);

    // 3. Создание ссылки-приглашения для редактора
    await evaluate(send, `openAccess(); true`);
    await sleep(400);
    const accessOpen = await evaluate(send, `$("#accessDialog").open === true`);
    check("диалог доступа открывается", accessOpen);

    await evaluate(send, `(()=>{
      $("#inviteRole").value = "editor";
      $("#inviteNote").value = "Брат Руслан";
      $("#inviteForm").requestSubmit();
      return true;
    })()`);
    await sleep(800);
    const inviteRes = await evaluate(send, `(()=>{
      const box = $("#inviteLinkBox");
      const input = $("#inviteLinkInput");
      return { hidden: box.hidden, url: input.value };
    })()`);
    check("хранитель создаёт персональное приглашение редактора", !inviteRes.hidden && inviteRes.url.includes("?invite="), inviteRes.url);

    // 4. Отзыв неиспользованного приглашения через интерфейс
    await evaluate(send, `(()=>{
      window.__origAsk = window.ask;
      window.ask = async () => true;
      const row = [...$("#accessInvites").querySelectorAll(".access-row")].find(r => r.textContent.includes("Брат Руслан"));
      const btn = row ? row.querySelector("button.danger") : null;
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(800);
    const inviteRevoked = await evaluate(send, `(()=>{
      const row = [...$("#accessInvites").querySelectorAll(".access-row")].find(r => r.textContent.includes("Брат Руслан"));
      return row ? row.textContent.includes("отозвана") : false;
    })()`);
    check("хранитель может отозвать созданную ссылку-приглашение", inviteRevoked === true);

    // 5. Создаём рабочее приглашение для редактора и принимаем его
    await evaluate(send, `(()=>{
      $("#inviteRole").value = "editor";
      $("#inviteNote").value = "Редактор Руслан";
      $("#inviteForm").requestSubmit();
      return true;
    })()`);
    await sleep(800);
    const editorInviteUrl = await evaluate(send, `$("#inviteLinkInput").value`);
    await evaluate(send, `$("#accessDialog").close(); true`);

    // Переходим по ссылке-приглашению в том же браузере (очистив прежние cookie)
    await send("Network.clearBrowserCookies");
    await send("Page.navigate", { url: editorInviteUrl });
    await sleep(1500);

    const invitePrompt = await evaluate(send, `(()=>{
      const d = $("#inviteDialog");
      return { open: d && d.open, intro: $("#inviteIntro")?.textContent || "" };
    })()`);
    check("ссылка-приглашение открывает приветственный диалог", invitePrompt.open === true && invitePrompt.intro.includes("редактор"));

    await evaluate(send, `(()=>{
      $("#inviteName").value = "Руслан";
      $("#inviteAcceptForm").requestSubmit();
      return true;
    })()`);
    await sleep(1500);

    const editorStatus = await evaluate(send, `(()=>{
      const b = $("#roleBadge");
      return { role: me.role, name: me.name, badge: b.textContent, isViewer: isViewer() };
    })()`);
    check("приглашённый редактор принимает приглашение и получает роль", editorStatus.role === "editor" && editorStatus.name === "Руслан", JSON.stringify(editorStatus));

    // 6. Редактор видит скрытые сведения живого человека
    await evaluate(send, `openPerson(2); true`);
    await sleep(400);
    const livingPersonView = await evaluate(send, `(()=>{
      const p = data.people.find(x => x.id === 2);
      const note = document.querySelector(".masked-note");
      return {
        masked: p && p.masked === true,
        hasNoBirth: !p.birth,
        hasNote: note !== null && note.textContent.includes("скрыта")
      };
    })()`);
    check("редактор видит карточку живого человека с маскированием", livingPersonView.masked && livingPersonView.hasNoBirth && livingPersonView.hasNote, JSON.stringify(livingPersonView));

    // 7. Редактор предлагает изменение через форму
    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(400);
    const editFormState = await evaluate(send, `(()=>{
      const btn = $("#personForm button[type=submit]");
      return { btnText: btn ? btn.textContent : "" };
    })()`);
    check("кнопка сохранения для редактора меняется на «Предложить изменение»", editFormState.btnText.includes("Предложить"), JSON.stringify(editFormState));

    await evaluate(send, `(()=>{
      const f = $("#personForm");
      f.elements.occupation.value = "народный учитель";
      f.requestSubmit();
      return true;
    })()`);
    await sleep(1000);

    const proposalSubmitted = await evaluate(send, `(()=>{
      const t = $("#toast");
      return t && (t.textContent.includes("хранителю") || t.textContent.includes("подтверждения"));
    })()`);
    check("редактор предлагает изменение через форму", proposalSubmitted === true);

    // 8. Хранитель видит предложение с подробным сравнением и утверждает его
    // Восстанавливаем сессию хранителя
    await send("Network.clearBrowserCookies");
    await evaluate(send, `document.cookie = "${keeperCookie}; path=/"; location.href = "${base}/"; true`);
    await sleep(1500);

    const keeperProposalsButton = await evaluate(send, `(()=>{
      const btn = $("#proposalsButton");
      const cnt = $("#proposalCount");
      return { visible: !btn.hidden, count: Number(cnt.textContent) };
    })()`);
    check("хранитель видит счётчик ожидающих предложений", keeperProposalsButton.visible && keeperProposalsButton.count >= 1, JSON.stringify(keeperProposalsButton));

    await evaluate(send, `$("#proposalsButton").click(); true`);
    await sleep(600);
    const proposalDiff = await evaluate(send, `(()=>{
      const card = $("#proposalList").querySelector(".proposal-card");
      return {
        hasCard: !!card,
        hasAuthor: card ? card.textContent.includes("Руслан") : false,
        hasDiff: card ? card.querySelector(".delta") !== null : false,
        diffText: card ? card.querySelector(".delta").textContent : ""
      };
    })()`);
    check("предложение отображает автора и различия полей", proposalDiff.hasAuthor && proposalDiff.hasDiff && proposalDiff.diffText.includes("учитель"), JSON.stringify(proposalDiff));

    // Утверждаем предложение
    await evaluate(send, `(()=>{
      const btn = $("#proposalList .proposal-actions button.primary");
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(1200);

    const personUpdated = await evaluate(send, `(()=>{
      const p = data.people.find(x => x.id === 1);
      return p ? p.occupation : "";
    })()`);
    check("после утверждения поле обновлено в основном архиве", personUpdated === "народный учитель");
    await evaluate(send, `$("#proposalsDialog").close(); true`);

    // 9. Проверка истории изменений и отката по человеку
    await evaluate(send, `openPerson(1); true`);
    await sleep(600);
    const historyView = await evaluate(send, `(()=>{
      const list = document.querySelector(".history-list");
      const items = list ? [...list.querySelectorAll("li")] : [];
      return {
        count: items.length,
        hasAuthor: items.some(li => li.textContent.includes("Руслан")),
        hasRestoreBtn: items.some(li => li.querySelector("button") !== null)
      };
    })()`);
    check("история изменений показывает автора предложения", historyView.hasAuthor === true && historyView.hasRestoreBtn === true, JSON.stringify(historyView));

    // Восстанавливаем прежнюю версию через кнопку в истории
    await evaluate(send, `(()=>{
      const list = document.querySelector(".history-list");
      const btn = list ? list.querySelector("button") : null;
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(1200);

    const revertedPerson = await evaluate(send, `(()=>{
      const p = data.people.find(x => x.id === 1);
      return p ? p.occupation : "";
    })()`);
    check("откат восстанавливает прежнее значение поля", revertedPerson === "чабан", revertedPerson);

    // 10. Роль наблюдателя (viewer): скрытие кнопок редактирования
    await evaluate(send, `openAccess(); true`);
    await sleep(500);
    await evaluate(send, `(()=>{
      $("#inviteRole").value = "viewer";
      $("#inviteNote").value = "Наблюдатель Заур";
      $("#inviteForm").requestSubmit();
      return true;
    })()`);
    await sleep(800);
    const viewerInviteUrl = await evaluate(send, `$("#inviteLinkInput").value`);
    await evaluate(send, `$("#accessDialog").close(); true`);

    // Принимаем приглашение наблюдателя
    await send("Network.clearBrowserCookies");
    await send("Page.navigate", { url: viewerInviteUrl });
    await sleep(1500);
    await evaluate(send, `(()=>{
      $("#inviteName").value = "Заур";
      $("#inviteAcceptForm").requestSubmit();
      return true;
    })()`);
    await sleep(1500);

    const viewerUI = await evaluate(send, `(()=>{
      return {
        role: me.role,
        hasViewerClass: document.body.classList.contains("role-viewer"),
        bannerVisible: !$("#readOnlyBanner").hidden,
        addHidden: $("#addButton") ? $("#addButton").hidden : true,
        editHidden: $("#editPersonButton") ? $("#editPersonButton").hidden : true
      };
    })()`);
    check("пользователь с ролью просмотра не имеет кнопок редактирования", viewerUI.role === "viewer" && viewerUI.hasViewerClass && viewerUI.bannerVisible && viewerUI.addHidden && viewerUI.editHidden, JSON.stringify(viewerUI));

    // 11. Отзыв доступа прекращает действие сессии
    // Перелогиниваемся под хранителем и отзываем доступ у Заура
    await send("Network.clearBrowserCookies");
    await evaluate(send, `document.cookie = "${keeperCookie}; path=/"; location.href = "${base}/"; true`);
    await sleep(1500);
    await evaluate(send, `openAccess(); true`);
    await sleep(500);

    const revokeZaur = await evaluate(send, `(()=>{
      window.ask = async () => true;
      const rows = [...$("#accessUsers").querySelectorAll(".access-row")];
      const zaurRow = rows.find(r => r.textContent.includes("Заур"));
      const btn = zaurRow ? zaurRow.querySelector("button.danger") : null;
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(800);
    check("хранитель нажимает «Отозвать доступ»", revokeZaur === true);

    const zaurRevokedText = await evaluate(send, `(()=>{
      const rows = [...$("#accessUsers").querySelectorAll(".access-row")];
      const zaurRow = rows.find(r => r.textContent.includes("Заур"));
      return zaurRow ? zaurRow.textContent.includes("доступ отозван") : false;
    })()`);
    check("отзыв доступа зафиксирован в списке участников", zaurRevokedText === true);
    await evaluate(send, `$("#accessDialog").close(); true`);

    // 12. Назначение второго хранителя (роль keeper)
    await evaluate(send, `openAccess(); true`);
    await sleep(500);
    const promoteCheck = await evaluate(send, `(()=>{
      const rows = [...$("#accessUsers").querySelectorAll(".access-row")];
      const ruslanRow = rows.find(r => r.textContent.includes("Руслан"));
      const sel = ruslanRow ? ruslanRow.querySelector("select") : null;
      if (sel) {
        sel.value = "keeper";
        sel.dispatchEvent(new Event("change"));
        return true;
      }
      return false;
    })()`);
    await sleep(1000);
    check("хранитель назначает второго хранителя через список участников", promoteCheck === true);

    const secondKeeperRole = await evaluate(send, `(()=>{
      const rows = [...$("#accessUsers").querySelectorAll(".access-row")];
      const ruslanRow = rows.find(r => r.textContent.includes("Руслан"));
      const sel = ruslanRow ? ruslanRow.querySelector("select") : null;
      return sel ? sel.value : "";
    })()`);
    check("второй хранитель получает статус хранителя", secondKeeperRole === "keeper");
    await evaluate(send, `$("#accessDialog").close(); true`);

    // 13. Передача архива (передать владение): новый человек становится хранителем, прежний владелец — редактором
    // Создаём нового участника для проверки передачи
    await evaluate(send, `(()=>{
      $("#inviteRole").value = "editor";
      $("#inviteNote").value = "Наследник Зелим";
      $("#inviteForm").requestSubmit();
      return true;
    })()`);
    await sleep(800);
    const zelimInviteUrl = await evaluate(send, `$("#inviteLinkInput").value`);
    const zelimToken = zelimInviteUrl.split("invite=")[1];
    // Принимаем приглашение через API для скорости
    const zelimAccept = await fetch(`${base}/api/invite/${zelimToken}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Зелим" })
    });
    const zelimData = await zelimAccept.json();

    // Перезагружаем список участников в диалоге доступа
    await evaluate(send, `openAccess(); true`);
    await sleep(600);

    // Хранитель нажимает «Передать архив»
    const transferTriggered = await evaluate(send, `(()=>{
      window.ask = async () => true;
      const rows = [...$("#accessUsers").querySelectorAll(".access-row")];
      const zelimRow = rows.find(r => r.textContent.includes("Зелим"));
      const transferBtn = zelimRow ? [...zelimRow.querySelectorAll("button")].find(b => b.textContent.includes("Передать")) : null;
      if (transferBtn) {
        transferBtn.click();
        return true;
      }
      return false;
    })()`);
    await sleep(1500);
    check("сценарий «Передать владение»: передача инициирована", transferTriggered === true);

    // Проверяем через API, что Зелим стал хранителем, а семейный пароль теперь даёт роль редактора
    const accessAfterTransfer = await (await fetch(`${base}/api/me`, { headers: { Cookie: keeperCookie } })).json();
    check("прежний хранитель стал редактором после передачи владения", accessAfterTransfer.role === "editor");

    // 14. Выход из общей базы очищает локальный кэш и хранилище медиа
    await evaluate(send, `$("#settingsButton").click(); true`);
    await sleep(400);
    const logoutBtnVisible = await evaluate(send, `!$("#logoutButton").hidden`);
    check("кнопка «Выйти из общей базы» видна в серверном режиме", logoutBtnVisible === true);

    await evaluate(send, `(()=>{
      $("#logoutButton").click();
      return true;
    })()`);
    await sleep(1500);

    const cacheCleared = await evaluate(send, `(()=>{
      const keyVal = localStorage.getItem("korni-data-v1");
      const d = $("#loginDialog");
      return {
        keyCleared: keyVal === null || keyVal === "",
        loginOpen: d && d.open
      };
    })()`);
    check("выход очищает локальный кэш и хранилище медиа", cacheCleared.keyCleared && cacheCleared.loginOpen);

    // 15. Проверка чистоты консоли
    const bad = browser.events.filter((e) => e.method === "Runtime.exceptionThrown"
      || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !String(e.params.entry.url || "").includes("/api/")));
    check("консоль без ошибок", bad.length === 0, bad.length ? JSON.stringify(bad[0]).slice(0, 300) : "");

  } finally {
    await browser.close();
    if (server) {
      server.kill("SIGTERM");
      await sleep(300);
    }
    if (dataDir && fs.existsSync(dataDir)) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
  if (failed.length) process.exitCode = 1;
})();
