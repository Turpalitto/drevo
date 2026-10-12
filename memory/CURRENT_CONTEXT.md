# Current Context

<!-- PROJECT-MEMORY-KIT:AUTOMATIC -->
- **Current focus:** Итерация 2 (продолжение): исправление GEDCOM-экспорта, кэш API, устойчивость cookie, чистка конфигов
- **Last completed step:** index.html: GEDCOM-экспорт переписан — убрана регулярка, которая съедала маркеры '0 @I…@ INDI' и '0 @F…@ FAM' и ломала файл; дата теперь в формате GEDCOM '12 MAY 1950' вместо числового месяца; добавлены ссылки '1 FAMC' от ребёнка к семье и завершающий '0 TRLR'; задействован ранее мёртвый famOfChild. Удалён мёртвый тёмный блок :root (перекрывался светлой палитрой). Убран неподключаемый шрифт Inter. server.js: Cache-Control: no-store для всех ответов API; parseCookies больше не падает на битой процентной последовательности в cookie. Удалён дубль конфига amvera.yaml (остался amvera.yml).
- **What changed:** index.html: GEDCOM-экспорт переписан — убрана регулярка, которая съедала маркеры '0 @I…@ INDI' и '0 @F…@ FAM' и ломала файл; дата теперь в формате GEDCOM '12 MAY 1950' вместо числового месяца; добавлены ссылки '1 FAMC' от ребёнка к семье и завершающий '0 TRLR'; задействован ранее мёртвый famOfChild. Удалён мёртвый тёмный блок :root (перекрывался светлой палитрой). Убран неподключаемый шрифт Inter. server.js: Cache-Control: no-store для всех ответов API; parseCookies больше не падает на битой процентной последовательности в cookie. Удалён дубль конфига amvera.yaml (остался amvera.yml).
- **What needs verification:** npm test — 8/8. node --check server.js и инлайн-скрипта — OK. GEDCOM проверен дважды: вырезанный из index.html фрагмент выполнен в Node с заглушками (10/10 проверок PASS) и реальный клик по кнопке в Chromium (10 записей INDI, завершение 0 TRLR, маркеры целы, консоль чистая). Сервер: /api/* → Cache-Control: no-store, ассеты → public max-age=86400, битая cookie %zz → 401 (не 500). Chromium: фон body остался #eee8d8, регрессий вида нет.
- **Next logical step:** Коммит итерации 2.
- **Important warnings:** Кэш API теперь no-store — при частом опросе /api/rev трафик чуть выше, но ответы маленькие. Оставлено намеренно: мёртвые тёмные правила (~130 строк) кроме :root, korni.service User=%i (README-HOME документирует замену через sed), узел брака в дереве, O(n²) на больших древах.
- **Affected files:** index.html, server.js, amvera.yaml (удалён)
- **Git status:** M .workbuddy-ai/memory/2026-10-11.md
 M Dockerfile
 M PROJECT_STATE.md
 M TODO.md
D  amvera.yaml
 M index.html
 M memory/.project-memory.json
 M memory/CURRENT_CONTEXT.md
 M package.json
 M server.js
?? memory/sessions/2026-10-11_18-10_2.md
