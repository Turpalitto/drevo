# Project Memory

Project Memory is a concise, repository-local summary that helps Codex, Claude Code, OpenCode, and other agents continue work across chats and machines. The code, tests, configuration, and Git state remain the source of truth.

- `CURRENT_CONTEXT.md` — short handoff for the next task.
- `sessions/` — meaningful session checkpoints only.
- `modules/` — notes for major subsystems, not every file.
- `decisions/` and `incidents/` — optional detailed records.
- `../PROJECT_STATE.md`, `../ARCHITECTURE.md`, `../DECISIONS.md`, `../TODO.md` — maintained project summaries.
- `../graph/project_graph.json` — coarse semantic map, never an AST dump.

Agents maintain these files as part of substantial tasks. Do not store secrets, logs, full diffs, dependency folders, or binaries. Memory is portable in Git and never outranks current reality.
