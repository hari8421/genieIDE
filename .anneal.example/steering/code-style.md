---
inclusion: always
---

# Project conventions

- TypeScript strict mode; no `any` in new code.
- Prefer small pure functions in `server/` modules and keep side effects at the edges.
- Tests live in `tests/` and use Vitest with real temp directories, not mocks of the filesystem.
- Every new failure mode must have a test that reproduces it.
- Never add a dependency without a one-line justification in the design doc.
