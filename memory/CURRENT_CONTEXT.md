# Current Context

<!-- PROJECT-MEMORY-KIT:AUTOMATIC -->
- **Current focus:** Итерация 1: проверка Git, обработка ошибок клиента, восстановление из бэкапа
- **Last completed step:** index.html: четыре пустых catch заменены понятными notify() — backupCurrent (резервная копия для отката), refreshContributions (обновление заявок), кнопка выхода, pollServer (опрос сервера). README.md: добавлена инструкция восстановления из data/backups/korni-<дата>.json через «Управление архивом» → «Восстановить из JSON».
- **What changed:** index.html: четыре пустых catch заменены понятными notify() — backupCurrent (резервная копия для отката), refreshContributions (обновление заявок), кнопка выхода, pollServer (опрос сервера). README.md: добавлена инструкция восстановления из data/backups/korni-<дата>.json через «Управление архивом» → «Восстановить из JSON».
- **What needs verification:** npm test — 8/8 ok. node --check инлайн-скрипта — OK. Восстановление проверено на копии базы: файл из data/backups принимается сервером как архив, rev растёт, sha256 рабочей data/korni.db не изменился.
- **Next logical step:** Первый коммит после подтверждения, что data/ отсутствует в индексе; при необходимости — антиспам уведомлений.
- **Important warnings:** Уведомление об ошибке выхода может не отобразиться: сразу после notify вызывается location.reload(). Уведомления в refreshContributions и pollServer при офлайне могут повторяться каждые 15 секунд.
- **Affected files:** index.html, README.md
- **Git status:** A  .dockerignore
A  .env.example
A  .freebuff/project-id
A  .gitignore
A  AGENTS.md
A  ARCHITECTURE.md
A  DECISIONS.md
A  Dockerfile
A  PROJECT_STATE.md
A  PROMPT-POLISH.md
A  README-HOME.md
AM README.md
A  TODO.md
A  amvera.yaml
A  amvera.yml
A  assets/archive-paper.jpg
A  design-qa.md
A  graph/project_graph.json
AM index.html
A  korni.service
AM memory/.project-memory.json
A  memory/CURRENT_CONTEXT.md
A  memory/README.md
A  memory/sessions/2026-09-12_12-41_session.md
A  memory/sessions/2026-09-12_13-10_session.md
A  memory/sessions/2026-09-13_10-50_interactive-lineage-and-kinship.md
A  memory/sessions/2026-09-13_11-32_family-contribution-approval-flow.md
A  memory/sessions/2026-09-14_08-36_workspace-refinement.md
A  package.json
A  server.js
A  start-home.bat
A  start-home.sh
A  test/server.test.js
