# drevo — Agent Instructions

This repository uses the global Project Memory Kit. Read the Project Memory Protocol below before substantial work.

Detected stack: Node.js. These are scan results, not architectural claims.

<!-- PROJECT-MEMORY-KIT:BEGIN -->
## Project Memory Protocol

`AGENTS.md` is the primary project instruction file. Project Memory is local to this repository and must never be mixed with another project. Never trust memory above executable behavior, current source/configuration, tests, and Git state. Unknown facts must be labeled `Unknown`, `Needs verification`, or `Inferred from code`. Never put secrets, full logs, full diffs, dependency folders, binaries, or generated caches in memory.

### Startup
1. Locate the project root and read this file.
2. If memory is absent and this is clearly a software project, run `pm-init --auto`.
3. Run `pm-doctor --fix --quiet` when safe, then read `PROJECT_STATE.md` and `memory/CURRENT_CONTEXT.md`.
4. Inspect `git status` and recent commits; load only relevant decisions, module memory, graph neighbors, and recent session notes.
5. Use `pm-context` for a compact working context before substantial work.

### During and after substantial work
Validate changes and review the diff. Update project state, current context, TODO, decisions, module memory, and graph only when the work changes their meaning. Use `pm-checkpoint` for a concise meaningful session summary, then run `pm-doctor --fix --quiet`. Small typo/readme-only changes do not require a checkpoint. Never commit, push, reset, or change production/business logic as memory maintenance.

The repository's code and tests are the source of truth; memory is a portable summary for continuity across agents.
<!-- PROJECT-MEMORY-KIT:END -->
