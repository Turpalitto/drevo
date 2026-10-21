// Проверка этапа 3 в настоящем браузере: даты с точностью, браки, места,
// оригиналы фото, документы, аудио, объединение дубликатов и GEDCOM.
// Запуск: npm run test:ui   (нужен Chrome/Chromium; путь можно задать KORNI_CHROME)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { launch, evaluate, sleep, browserPath } = require("./cdp");

const ROOT = path.resolve(__dirname, "../..");
const MIME = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".css": "text/css" };

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? " · " + detail : ""}`);
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/")) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"error":"not found"}'); }
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
  if (!browserPath()) {
    console.log("SKIP — браузер не найден, UI-проверки пропущены (задайте KORNI_CHROME)");
    return;
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const { send } = browser;
  try {
    await send("Page.navigate", { url: base + "/" });
    await sleep(1200);
    check("приложение загрузилось", await evaluate(send, `typeof data === "object" && typeof commit === "function"`) === true);

    // --- Даты с точностью ---
    check("dateText: около", await evaluate(send, `dateText("",1930,"abt",null)`) === "≈1930");
    check("dateText: до", await evaluate(send, `dateText("",1930,"bef",null)`) === "до 1930");
    check("dateText: после", await evaluate(send, `dateText("",1930,"aft",null)`) === "после 1930");
    check("dateText: интервал", await evaluate(send, `dateText("",1930,"between",1935)`) === "1930–1935");

    await evaluate(send, `commit(demo(),"Демо для проверки"); true`);
    await sleep(250);
    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(150);
    check("второй год скрыт без интервала", await evaluate(send, `document.querySelector('.q2-field[data-q="birth"]').hidden`) === true);

    await evaluate(send, `(()=>{const f=document.querySelector("#personForm");f.elements.birth.value="1930";f.elements.birthQ.value="abt";f.requestSubmit();return true})()`);
    await sleep(500);
    const abt = await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return {q:p.birthQ,q2:p.birthQ2,text:years(p)}})()`);
    check("точность «около» сохранилась", abt.q === "abt" && abt.q2 === null, JSON.stringify(abt));
    check("в подписи ≈", String(abt.text).includes("≈1930"), abt.text);

    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(150);
    await evaluate(send, `(()=>{const f=document.querySelector("#personForm");f.elements.birth.value="1930";f.elements.birthQ.value="between";f.elements.birthQ2.value="1935";f.requestSubmit();return true})()`);
    await sleep(500);
    const between = await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return {q:p.birthQ,q2:p.birthQ2,text:years(p)}})()`);
    check("интервал сохранился", between.q === "between" && between.q2 === 1935, JSON.stringify(between));
    check("в подписи интервал", String(between.text).includes("1930–1935"), between.text);

    const badQual = await evaluate(send, `(()=>{try{validatePeople([{...blankPerson(1),name:"Тест",sex:"M",birth:1930,birthQ:"exact",birthQ2:1940}]);return "нет ошибки"}catch(e){return e.message}})()`);
    check("второй год без интервала отклоняется", String(badQual).includes("интервал"), badQual);

    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(120);
    await evaluate(send, `(()=>{const f=document.querySelector("#personForm");f.elements.birthQ.value="exact";f.requestSubmit();return true})()`);
    await sleep(400);

    // --- Браки ---
    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(150);
    await evaluate(send, `(()=>{const cb=document.querySelector('#spouseList input[value="2"]');cb.checked=true;cb.dispatchEvent(new Event("change"));return true})()`);
    await sleep(100);
    check("блок браков появился", await evaluate(send, `!document.querySelector("#unionBlock").hidden`) === true);
    await evaluate(send, `(()=>{const f=document.querySelector("#personForm");f.elements.birthQ.value="";const inputs=document.querySelectorAll("#unionList input");inputs[0].value="1955";inputs[0].dispatchEvent(new Event("input"));inputs[1].value="1970";inputs[1].dispatchEvent(new Event("input"));f.requestSubmit();return true})()`);
    await sleep(500);
    const union = await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return p.unions})()`);
    check("брак с годами сохранился", Array.isArray(union) && union.length === 1 && union[0].from === "1955" && union[0].to === "1970", JSON.stringify(union));
    await evaluate(send, `renderProfile(data.people.find(x=>x.id===1)); true`);
    await sleep(100);
    check("брак виден в карточке", await evaluate(send, `document.querySelector("#profileSections").textContent.includes("1955–1970")`) === true);

    // --- Исторические и современные названия ---
    await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);p.birthPlace="Старое село";p.birthPlaceNow="Новое село";commit(copy(),"Проверка мест");return true})()`);
    await sleep(300);
    await evaluate(send, `setDetailLevel("detailed");renderProfile(data.people.find(x=>x.id===1));true`);
    await sleep(150);
    check("историческое и современное название", await evaluate(send, `document.querySelector("#profileSections").textContent.includes("Старое село (сейчас — Новое село)")`) === true);
    await evaluate(send, `setDetailLevel("simple");true`);

    // --- Фото: оригинал и подпись ---
    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(150);
    const photo = await evaluate(send, `(async()=>{
      const c=document.createElement("canvas");c.width=60;c.height=80;
      c.getContext("2d").fillRect(0,0,60,80);
      const blob=await new Promise(r=>c.toBlob(r,"image/png"));
      const input=document.querySelector("#photoInput");
      const dt=new DataTransfer();dt.items.add(new File([blob],"ahmed.png",{type:"image/png"}));input.files=dt.files;
      input.dispatchEvent(new Event("change"));
      await new Promise(r=>setTimeout(r,500));
      return {metaVisible:!document.querySelector("#photoMetaFields").hidden,preview:!!document.querySelector("#photoPreview").src};
    })()`);
    check("поля подписи появились вместе с фото", photo.metaVisible === true && photo.preview === true, JSON.stringify(photo));

    await evaluate(send, `(()=>{const f=document.querySelector("#personForm");f.elements.photoDate.value="1950";f.requestSubmit();return true})()`);
    await sleep(700);
    const savedPhoto = await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return p.photoMeta?{date:p.photoMeta.date,mediaId:!!p.photoMeta.mediaId}:null})()`);
    check("подпись и дата фото сохранены", !!savedPhoto && savedPhoto.date === "1950", JSON.stringify(savedPhoto));
    check("оригинал фото сохранён отдельно", savedPhoto && savedPhoto.mediaId === true);
    const original = await evaluate(send, `(async()=>{const p=data.people.find(x=>x.id===1);const rec=await getMedia(p.photoMeta.mediaId);return rec?{size:rec.size}:null})()`);
    check("оригинал читается из хранилища", !!original && original.size > 0, JSON.stringify(original));

    await evaluate(send, `setDetailLevel("detailed");renderProfile(data.people.find(x=>x.id===1));true`);
    await sleep(150);
    check("кнопка «Скачать оригинал» есть", await evaluate(send, `[...document.querySelectorAll("#profileSections button")].some(b=>b.textContent.includes("Скачать оригинал"))`) === true);
    await evaluate(send, `setDetailLevel("simple");true`);

    // --- Документы ---
    await evaluate(send, `openPerson(1); openEdit(true); true`);
    await sleep(150);
    await evaluate(send, `(async()=>{
      await saveMedia({id:"doc-test-1",blob:new Blob(["x"],{type:"text/plain"}),name:"svidetelstvo.txt",type:"text/plain",size:13,at:new Date().toISOString()});
      document.querySelector("#addDocument").click();
      await new Promise(r=>setTimeout(r,80));
      const input=document.querySelectorAll("#documentsList .editor-item input")[0];
      input.value="Свидетельство о рождении";input.dispatchEvent(new Event("input"));
      const doc=draftDocuments[0];doc.mediaId="doc-test-1";doc.fileName="svidetelstvo.txt";doc.fileType="text/plain";doc.fileSize=13;
      renderDocuments();document.querySelector("#personForm").requestSubmit();
      return true;
    })()`);
    await sleep(600);
    const docs = await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return p.documents.map(d=>({title:d.title,mediaId:d.mediaId}))})()`);
    check("документ сохранён", Array.isArray(docs) && docs.length === 1 && docs[0].title === "Свидетельство о рождении", JSON.stringify(docs));
    await evaluate(send, `setDetailLevel("detailed");renderProfile(data.people.find(x=>x.id===1));true`);
    await sleep(150);
    check("раздел «Документы» виден", await evaluate(send, `document.querySelector("#profileSections").textContent.includes("Документы")`) === true);
    check("у документа есть скачивание", await evaluate(send, `[...document.querySelectorAll("#profileSections button")].some(b=>b.textContent.includes("Скачать файл"))`) === true);
    await evaluate(send, `setDetailLevel("simple");true`);

    // --- Аудиовоспоминание ---
    await evaluate(send, `(async()=>{
      await saveMedia({id:"aud-test-1",blob:new Blob([new Uint8Array(64)],{type:"audio/webm"}),name:"rasskaz.webm",type:"audio/webm",size:64,at:new Date().toISOString()});
      const p=data.people.find(x=>x.id===1);
      p.memories.push({id:"m-test-1",text:"",author:"Хеда",at:"2024",audio:{mediaId:"aud-test-1",fileName:"rasskaz.webm",fileType:"audio/webm",fileSize:64,duration:0}});
      commit(copy(),"Воспоминание с записью");
      setDetailLevel("detailed");renderProfile(data.people.find(x=>x.id===1));
      return true;
    })()`);
    await sleep(600);
    check("воспоминание без текста, но с записью сохранено", await evaluate(send, `(()=>{const p=data.people.find(x=>x.id===1);return p.memories.some(m=>m.audio&&m.audio.mediaId==="aud-test-1")})()`) === true);
    check("плеер появился в карточке", await evaluate(send, `!!document.querySelector("#profileSections audio")`) === true);
    check("подпись про расшифровку", await evaluate(send, `document.querySelector("#profileSections").textContent.includes("Расшифровка пока не сделана")`) === true);
    await evaluate(send, `setDetailLevel("simple");true`);

    // --- Похожие записи и объединение ---
    await evaluate(send, `(()=>{
      const a=migrate({id:100});a.name="Хасан";a.sex="M";a.birth=1940;
      const b=migrate({id:101});b.name="Хасан";b.sex="M";b.birth=1941;
      const child=migrate({id:102});child.name="Ребёнок";child.sex="M";child.father=101;
      const next=copy();next.people.push(a,b,child);commit(next,"Тестовые дубликаты");return true;
    })()`);
    await sleep(400);
    const groups = await evaluate(send, `duplicateGroups().map(g=>g.map(p=>p.id))`);
    check("похожие записи найдены", Array.isArray(groups) && groups.some(g => g.includes(100) && g.includes(101)), JSON.stringify(groups));

    await evaluate(send, `(()=>{mergeGroup([100,101],100);setTimeout(()=>closeAsk(true),60);return true})()`);
    await sleep(900);
    const merged = await evaluate(send, `(()=>{
      const keep=data.people.find(x=>x.id===100);
      const drop=data.people.find(x=>x.id===101);
      const child=data.people.find(x=>x.id===102);
      return {keep:!!keep,drop:!!drop,childFather:child?child.father:null,sourceCount:keep?keep.sources.length:0};
    })()`);
    check("лишняя запись удалена", merged.keep === true && merged.drop === false, JSON.stringify(merged));
    check("ребёнок перешёл к оставшейся записи", merged.childFather === 100, `father=${merged.childFather}`);
    check("расхождение сохранено как источник", merged.sourceCount >= 1, `sources=${merged.sourceCount}`);

    // --- GEDCOM ---
    check("GEDCOM: около", await evaluate(send, `gedcomDateValue({birth:1930,birthQ:"abt"},"birth")`) === "ABT 1930");
    check("GEDCOM: до", await evaluate(send, `gedcomDateValue({birth:1930,birthQ:"bef"},"birth")`) === "BEF 1930");
    check("GEDCOM: интервал", await evaluate(send, `gedcomDateValue({birth:1930,birthQ:"between",birthQ2:1935},"birth")`) === "BET 1930 AND 1935");

    // --- Перенос оригиналов ---
    const media = await evaluate(send, `(async()=>{const m=await allMedia();return {count:m.length,hasBlob:m.every(x=>x.blob instanceof Blob)}})()`);
    check("оригиналы доступны для выгрузки", media.count >= 2 && media.hasBlob === true, JSON.stringify(media));
    const roundtrip = await evaluate(send, `(async()=>{
      const m=await allMedia();const rec=m[0];
      const b64=await blobToBase64(rec.blob);
      const back=base64ToBlob(b64,rec.type);
      return back.size===rec.blob.size;
    })()`);
    check("файл переживает кодирование в архив", roundtrip === true);

    // --- Консоль ---
    const consoleErrors = browser.events.filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error");
    const real = consoleErrors.filter((e) => !JSON.stringify(e.params.args || []).includes("404"));
    check("консоль без ошибок", real.length === 0, real.map((e) => JSON.stringify(e.params.args)).join(" | ").slice(0, 300));
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
  process.exit(failed.length ? 1 : 0);
})();
