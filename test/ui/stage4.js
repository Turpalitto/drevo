// Проверка этапа 4 в настоящем браузере: уровни детализации древа, точки брака,
// читаемость имён издалека, сохранение места при переходе к человеку, свёрнутые
// ветки, reduced-motion, телефон и доступность поиска.
// Запуск: npm run test:ui   (нужен Chrome/Chromium; путь можно задать KORNI_CHROME)
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
    if (url.pathname.startsWith("/api/")) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"error":"not found"}'); }
    const file = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Четыре поколения, пары на каждом уровне: 68 человек. Данные вымышленные и
// строятся в браузере, чтобы не тащить фикстуру в репозиторий.
const BUILD = `(()=>{
  const names=["Ахмед","Аминат","Муса","Малика","Хеда","Идрис","Зарема","Мадина","Адам","Амина",
    "Тимур","Хава","Ислам","Селима","Рамзан","Луиза","Аслан","Петимат","Шамиль","Тамара",
    "Юсуп","Хадижат","Ибрагим","Зухра","Сайд","Марьям","Вахар","Ясмина","Али","Роза",
    "Дени","Хава","Салман","Иман","Бекхан","Марем","Хасан","Лейла","Умар","Сацита",
    "Асхаб","Малика","Юнус","Рамнат"];
  let id=1;const people=[];let ni=0;
  const nm=()=>names[ni++%names.length];
  const add=(sex,birth,father,mother)=>{const p=person(id++,nm(),sex,birth,father,mother);people.push(p);return p};
  const marry=(a,b)=>{a.spouses=[b.id];b.spouses=[a.id]};
  const pair=(a,b)=>a.sex==="M"?[a.id,b.id]:[b.id,a.id];
  const root=[];
  for(let i=0;i<2;i++){const h=add("M",1928+i*6),w=add("F",1932+i*6);marry(h,w);root.push([h,w])}
  const gen1=[];
  for(const [h,w] of root)for(let i=0;i<4;i++){
    const child=add(i%2?"F":"M",1952+i*4,...pair(h,w));
    const sp=add(i%2?"M":"F",1954+i*4);
    marry(child,sp);gen1.push([child,sp]);
  }
  const gen2=[];
  for(const [h,w] of gen1)for(let i=0;i<2;i++){
    const child=add(i?"F":"M",1978+i*3,...pair(h,w));
    const sp=add(i?"M":"F",1980+i*3);
    marry(child,sp);gen2.push([child,sp]);
  }
  for(const [h,w] of gen2)add("M",2004,...pair(h,w));
  return ensureUids({format:"korni-local",version:1,rev:1,title:"Проверка древа",demo:true,log:[],people:people.map(migrate)});
})()`;

(async () => {
  if (!browserPath()) {
    console.log("SKIP — браузер не найден, проверки древа пропущены (задайте KORNI_CHROME)");
    return;
  }
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const { send } = browser;
  try {
    await send("Page.navigate", { url: base + "/" });
    await sleep(1200);
    await evaluate(send, `commit(${BUILD},"Древо для проверки"); setDetailLevel("simple"); setMode("all"); true`);
    await sleep(500);

    // --- Что нарисовано ---
    const stats = await evaluate(send, `(()=>{
      const ids=new Set(visiblePeople().people.map(p=>p.id));
      return {people:data.people.length,nodes:document.querySelectorAll("#tree .node").length,
        bands:document.querySelectorAll("#tree .generation-band").length,
        unions:document.querySelectorAll("#tree .union-dot").length,
        arms:document.querySelectorAll("#tree .edge.union-arm").length,
        childLines:document.querySelectorAll("#tree .edge.union-child").length,
        twoParents:visiblePeople().people.filter(p=>parents(p,ids).length===2).length};
    })()`);
    check("на древе все люди", stats.nodes === stats.people, `${stats.nodes} узлов / ${stats.people} человек`);
    check("полосы поколений нарисованы", stats.bands >= 2, `${stats.bands}`);
    check("у пары одна точка брака", stats.unions > 0 && stats.arms === stats.unions * 2, `точек ${stats.unions}, плеч ${stats.arms}`);
    check("к ребёнку идёт одна общая линия", stats.childLines === stats.twoParents, `${stats.childLines} линий на ${stats.twoParents} детей`);

    // --- Геометрия: наложения карточек и пересечения линий ---
    const geo = await evaluate(send, `(()=>{
      const ids=new Set(visiblePeople().people.map(p=>p.id));
      const rects=[...positions.entries()].filter(([id])=>ids.has(id)).map(([,p])=>({x:p.x,y:p.y}));
      let overlap=0;
      for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++)
        if(Math.abs(rects[i].x-rects[j].x)<NODE_W-1&&Math.abs(rects[i].y-rects[j].y)<NODE_H-1)overlap++;
      const segs=[],seen=new Set();
      for(const p of visiblePeople().people){
        const t=positions.get(p.id);if(!t)continue;
        const ps=parents(p,ids);
        if(ps.length===2){
          const a=positions.get(ps[0]),c=positions.get(ps[1]);
          if(!a||!c)continue;
          const key=Math.min(ps[0],ps[1])+"-"+Math.max(ps[0],ps[1]);
          const u={x:(a.x+c.x)/2+NODE_CX,y:Math.max(a.y,c.y)+NODE_H+16};
          if(!seen.has(key)){seen.add(key);
            segs.push({fam:key,a:{x:a.x+NODE_CX,y:a.y+NODE_H},b:u});
            segs.push({fam:key,a:{x:c.x+NODE_CX,y:c.y+NODE_H},b:u});}
          segs.push({fam:key,a:u,b:{x:t.x+NODE_CX,y:t.y}});
        } else for(const pid of ps){
          const s=positions.get(pid);if(!s)continue;
          segs.push({fam:"p"+pid+"-"+p.id,a:{x:s.x+NODE_CX,y:s.y+NODE_H},b:{x:t.x+NODE_CX,y:t.y}});
        }
      }
      const cross=(p,q,r,s)=>{const d=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
        const d1=d(r,s,p),d2=d(r,s,q),d3=d(p,q,r),d4=d(p,q,s);
        return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));};
      let crossings=0;
      for(let i=0;i<segs.length;i++)for(let j=i+1;j<segs.length;j++)
        if(segs[i].fam!==segs[j].fam&&cross(segs[i].a,segs[i].b,segs[j].a,segs[j].b))crossings++;
      return {overlap,crossings,segs:segs.length};
    })()`);
    check("карточки не наезжают друг на друга", geo.overlap === 0, `наложений ${geo.overlap}`);
    check("линии почти не пересекаются", geo.crossings / geo.segs < 0.35, `${geo.crossings} пересечений на ${geo.segs} линий`);

    // --- Компьютер: масштаб и уровни детализации ---
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    await evaluate(send, `fitTree(); true`);
    await sleep(400);
    const fit = await evaluate(send, `(()=>{
      const n=document.querySelector("#tree .node-compact .name");
      return {s:camera.s,far:svg.classList.contains("lod-far"),
        compact:!!n&&getComputedStyle(n.closest(".node-compact")).display!=="none",
        fontPx:n?parseFloat(getComputedStyle(n).fontSize):0};
    })()`);
    check("масштаб не ниже читаемого", fit.s >= 0.52 - 1e-6, `s=${fit.s.toFixed(3)}`);
    check("издалека показываются крупные имена", fit.far && fit.compact, `lodFar=${fit.far}`);
    check("имя издалека читается", fit.fontPx * fit.s >= 10.5, `${(fit.fontPx * fit.s).toFixed(1)} px на экране`);
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    await screenshot(send, path.join(OUT, "tree-far.png"), 1440, 900);

    await evaluate(send, `camera.s=0.78; applyCamera(); true`);
    await sleep(300);
    const mid = await evaluate(send, `({mid:svg.classList.contains("lod-mid"),far:svg.classList.contains("lod-far"),
      tag:(()=>{const t=document.querySelector("#tree .node .tag");return t?getComputedStyle(t).display!=="none":false})()})`);
    check("средний масштаб: карточка без подписи", mid.mid && !mid.far && !mid.tag, JSON.stringify(mid));
    await screenshot(send, path.join(OUT, "tree-mid.png"), 1440, 900);

    await evaluate(send, `camera.s=1.05; applyCamera(); true`);
    await sleep(300);
    const near = await evaluate(send, `({far:svg.classList.contains("lod-far"),mid:svg.classList.contains("lod-mid"),
      full:(()=>{const f=document.querySelector("#tree .node-full");return f?getComputedStyle(f).display!=="none":false})()})`);
    check("близкий масштаб: портрет, годы и подпись", !near.far && !near.mid && near.full, JSON.stringify(near));
    await screenshot(send, path.join(OUT, "tree-near.png"), 1440, 900);

    // --- Переход к человеку не сбрасывает камеру ---
    await evaluate(send, `fitTree(); true`);
    await sleep(300);
    const before = await evaluate(send, `({x:camera.x,y:camera.y,s:camera.s})`);
    await evaluate(send, `(()=>{const id=[...positions.keys()].find(k=>{const p=positions.get(k),r=svg.getBoundingClientRect();
      const sx=camera.x+p.x*camera.s,sy=camera.y+p.y*camera.s;
      return sx>0&&sy>0&&sx<r.width-300&&sy<r.height-200});openPerson(id);return id})()`);
    await sleep(700);
    const after = await evaluate(send, `({x:camera.x,y:camera.y,s:camera.s,open:$("#personDialog").open})`);
    check("карточка человека открылась", after.open === true);
    check("масштаб не сбросился при открытии", Math.abs(after.s - before.s) < 0.001, `${before.s.toFixed(3)} → ${after.s.toFixed(3)}`);
    check("камера не прыгнула без нужды", Math.abs(after.x - before.x) < 60 && Math.abs(after.y - before.y) < 60,
      `Δx=${Math.abs(after.x - before.x).toFixed(1)} Δy=${Math.abs(after.y - before.y).toFixed(1)}`);
    await evaluate(send, `$("#personDialog").close(); true`);
    await sleep(600);
    const cleared = await evaluate(send, `({highlight:highlightId,dim:svg.classList.contains("tree-has-lineage")})`);
    check("после закрытия карточки древо снова читается целиком", cleared.highlight === null && cleared.dim === false, JSON.stringify(cleared));

    // --- Панель не пересобирает древо ---
    const s0 = await evaluate(send, `camera.s`);
    await evaluate(send, `$("#sidebarToggle").click(); true`);
    await sleep(600);
    const s1 = await evaluate(send, `camera.s`);
    check("панель открывается без пересборки древа", Math.abs(s1 - s0) < 0.001, `${s0.toFixed(3)} → ${s1.toFixed(3)}`);
    await evaluate(send, `$("#sidebarToggle").click(); true`);
    await sleep(400);

    // --- Свёрнутая ветка ---
    const collapse = await evaluate(send, `(()=>{
      const parent=data.people.find(p=>childrenOf(p.id).length>=2);
      toggleCollapse(parent.id);
      const btn=[...document.querySelectorAll("#tree .collapse-btn")].find(b=>b.closest(".node").dataset.pid==String(parent.id));
      return {label:btn?btn.textContent:"",visible:document.querySelectorAll("#tree .node").length,all:data.people.length};
    })()`);
    check("свёрнутая ветка показывает число скрытых", /^\+\d+$/.test(collapse.label), collapse.label);
    check("скрытые не рисуются", collapse.visible < collapse.all, `${collapse.visible} из ${collapse.all}`);
    await evaluate(send, `collapsed.clear(); render(true); true`);
    await sleep(400);

    // --- Reduced motion ---
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const rm = await evaluate(send, `(()=>{const from={x:camera.x,y:camera.y};
      animateCameraTo(camera.x+300,camera.y+120,0.9,280);
      return Math.abs(camera.x-(from.x+300))<1&&Math.abs(camera.s-0.9)<0.001})()`);
    check("при reduced-motion переход без анимации", rm === true);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

    // --- Телефон ---
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(400);
    await evaluate(send, `fitTree(); true`);
    await sleep(400);
    const mob = await evaluate(send, `(()=>{
      const add=$("#treeAddButton"),r=svg.getBoundingClientRect();
      return {s:camera.s,addVisible:!!add&&add.offsetParent!==null&&add.getBoundingClientRect().width>0,
        hScroll:document.documentElement.scrollWidth>innerWidth+1,stageH:r.height};
    })()`);
    check("на телефоне древо не сплющено", mob.s >= 0.6 - 1e-6, `s=${mob.s.toFixed(3)}`);
    check("древу отдана половина экрана", mob.stageH >= 320, `${Math.round(mob.stageH)} px`);
    check("главное действие «добавить» на виду", mob.addVisible === true);
    check("нет случайной горизонтальной прокрутки страницы", mob.hScroll === false);
    await screenshot(send, path.join(OUT, "tree-mobile.png"), 390, 844);

    const search = await evaluate(send, `(()=>{
      const btn=$("#searchButton"),r=btn.getBoundingClientRect();
      const visible=r.width>20&&r.height>20&&r.top>=0&&r.top<160;
      btn.click();
      const d=$("#searchDialog"),inp=$("#globalSearch"),ir=inp.getBoundingClientRect();
      return {visible,dialog:d.open,input:ir.width>80};
    })()`);
    check("поиск доступен с телефона", search.visible === true, JSON.stringify(search));
    check("поиск открывается отдельным окном", search.dialog === true && search.input === true, JSON.stringify(search));
    await evaluate(send, `$("#searchDialog").close(); true`);
    await sleep(300);

    const tapId = await evaluate(send, `(()=>{const n=document.querySelector("#tree .node");const id=Number(n.dataset.pid);centerOn(id);return id})()`);
    await sleep(600);
    const xy = await evaluate(send, `(()=>{const n=document.querySelector('#tree .node[data-pid="${tapId}"]');const r=n.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: xy.x, y: xy.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: xy.x, y: xy.y, button: "left", clickCount: 1 });
    await sleep(700);
    const sheet = await evaluate(send, `(()=>{const d=$("#personDialog"),r=d.getBoundingClientRect();
      return {open:d.open,w:r.width,top:r.top}})()`);
    check("по нажатию открывается карточка человека", sheet.open === true, JSON.stringify(sheet));
    await evaluate(send, `$("#personDialog").close(); true`);

    const bad = browser.events.filter((e) => e.method === "Runtime.exceptionThrown"
      || (e.method === "Log.entryAdded" && e.params.entry.level === "error" && !String(e.params.entry.url || "").includes("/api/")));
    check("консоль без ошибок", bad.length === 0, bad.length ? JSON.stringify(bad[0]).slice(0, 300) : "");
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
  if (failed.length) process.exitCode = 1;
})();
