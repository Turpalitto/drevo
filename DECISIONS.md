# Decisions

<!-- PROJECT-MEMORY-KIT:GENERATED -->
Record only important decisions using the ADR format in `memory/decisions/` or below.

## ADR-001 — Project Memory protocol

Status: Accepted
Date: 2026-09-12

### Context
Agents need a portable, project-local continuity layer.

### Decision
Use Markdown, JSON, Git, and the local stdlib-only Project Memory Kit.

### Why
Readable, portable, dependency-light, and independent of external LLM APIs.

### Alternatives considered
External vector/database memory; rejected for the initial implementation.

### Consequences
Agents must follow the repository protocol and keep summaries concise.

## ADR-09121310 — Recorded decision

Status: Accepted
Date: 2026-09-12

### Decision

Сохранено интерактивное SVG-древо и вся существующая логика; на desktop карточка немодальная, на mobile модальная; реальные фото используются при наличии, иначе показываются инициалы.
