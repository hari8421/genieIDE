# genie — Progress

Last updated: 2026-11-10
Branch: `main`
Stage: **M2 — local-first agentic IDE with desktop executables, pluggable providers and cross-run agent memory.**

---

## 1. Verification snapshot

| Gate | Command | Result |
| --- | --- | --- |
| Unit + integration tests | `npm test` | **16 files, 122 tests passing** (5 new: SSE transcript reducer) |
| Type safety | `npm run typecheck` (`tsc --noEmit`) | passing |
| Production bundle | `npm run build` (typecheck + `vite build`) | passing |
| Desktop executables | `node scripts/build-desktop.mjs` | **exit 0**, three binaries (Linux 78 MB, macOS arm64 70 MB, Windows 97 MB) |
| Runtime end-to-end | stub OpenAI-compatible server + 24-check driver | **24/24** against the `tsx` server *and* the packaged Linux binary: provider routing, bearer key, SSE run, pinned memory in the prompt, `remember` tool, fact delete, path escape, SPA assets |
| Packaged binary smoke test | `pkg-out/genie/genie-ide-linux-x64` → `/api/health`, `/api/memory`, `/` | passing (real HTTP responses served from the binary) |
| Memory across restarts | restart the binary on the same workspace | passing — `core.md` rebuilt from `facts.jsonl`, facts and event count intact |
| Provider + memory regression | `tests/provider-memory.e2e.test.ts` (in `npm test`) | the throwaway driver is now a committed test: stub provider, bearer key, real prompt asserts |
| Debugger (real inspector) | `tests/debug.test.ts` | breakpoint pause, locals, in-frame evaluation and stepping against a live `node --inspect-brk` child |
| Language service | `tests/intel.test.ts` | source bundle filters, size caps, truncation flag |
| Transcript reducer | `tests/session.test.ts` | wrapped `{type, step, data}` events, delta streaming, tool pairing, unwrapped `result`/`error` |
| UI in a browser | headless Chromium against `npm run dev` | quick open, file open, agent run, spec panel, runs, undo, models, plus per-tab undo history and the unsaved-close guard — screenshots in `docs/images/` (stub OpenAI-compatible endpoint, not LM Studio) |
| Preview host | `curl -H 'Host: <preview>'` | **403 → 200** after `GENIE_ALLOWED_HOSTS` wiring (Vite 5 ignores `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`) |
| HTTP smoke test | bundled server + `/api/health`, `/api/files` | passing |
| Real LM Studio end-to-end | requires a local model | **not verified here** — no model server exists in the cloud runner |
| macOS / Windows binaries executed | requires those hosts | **not verified** — format-checked (Mach-O arm64, PE32+ x86-64) but only the Linux ELF was run |

The suite is not a smoke test: it starts a real API server against a temporary workspace, spawns
a real MCP child process, and drives the agent loop through success, tool failure, context
overflow, cancellation and resume paths.

---

## 2. What is implemented

### Model layer
- [x] OpenAI-compatible client for LM Studio (`server/llm/client.ts`)
- [x] **Provider switch**: LM Studio (default) or any external OpenAI-compatible API
      (`provider`, `externalBaseUrl`, `externalModel`, `externalApiKey`)
- [x] API key sent as a bearer token; key lives in `.genie/config.json` (git-ignored) or
      `GENIE_EXTERNAL_API_KEY`
- [x] SSE streaming with incremental assistant text
- [x] Tool-call assembly from fragmented deltas
- [x] Model discovery with context length (`GET /models`)
- [x] Retry with exponential backoff + jitter, retryable-vs-final classification
- [x] Circuit breaker with half-open probe
- [x] No replay after tokens have streamed
- [x] JSON repair loop for structured output (`server/llm/structured.ts`)

### Agent memory
- [x] File-backed store under `.genie/memory/` (`server/memory/store.ts`)
- [x] Durable facts in `facts.jsonl`, deduplicated by key
- [x] `core.md` rendered from the facts, capped at `maxCoreLines`, injected into every prompt as
      a **pinned context section** (never dropped, only truncated under budget pressure)
- [x] Run outcomes journaled to `events.jsonl`, pruned to `maxEvents`
- [x] `remember` tool so the model persists conventions and gotchas itself
- [x] `GET /api/memory`, `POST /api/memory/facts`, `DELETE /api/memory/facts/:key`
- [x] Models tab lists, adds and forgets facts; status bar shows the memory count

### Desktop app
- [x] `scripts/build-desktop.mjs` produces standalone executables via `@yao-pkg/pkg`
- [x] Server bundled to a single CommonJS file with esbuild; the built SPA ships as pkg assets
- [x] Same `createServer` code path as the dev server (`server/http.ts`), so there is no
      desktop-only behaviour to keep in sync
- [x] `build-desktop` / `start-desktop` npm scripts; `GENIE_DESKTOP_TARGETS`,
      `GENIE_DESKTOP_OUT`, `GENIE_DESKTOP_SKIP_PKG` overrides
- [x] Opens the dashboard in the default browser on launch (`GENIE_NO_OPEN=1` opts out); a missing
      opener warns instead of failing the start
- [x] Build reports a non-zero exit when pkg fails or produces nothing, and waits for pkg's
      outliving writers before scanning for outputs

### Debugger
- [x] Real Node debugging over the inspector protocol (CDP over WebSocket, no dependency)
- [x] Breakpoints with verification state, persisted in the editor gutter (F9)
- [x] Continue / pause / step over / step into / step out
- [x] Call stack with clickable frames; locals grouped per scope
- [x] Evaluate expressions in the paused frame
- [x] Console, stdout and stderr streamed into the panel
- [x] Refuses scripts outside the workspace; reports missing ones instead of hanging
- [x] Debugs from the packaged desktop binary when Node.js is installed (`GENIE_NODE` overrides the
      interpreter)

### Language intelligence (peek / navigation)
- [x] Workspace source bundle served to the editor (`GET /api/intel/sources`), capped and
      truncation-aware
- [x] Monaco TypeScript service fed as extra libs on `file:///workspace/...` URIs
- [x] Go to definition, peek definition, find usages, implementations, hover, outline
- [x] Inline diagnostics from the same service
- [x] Open models take precedence over libs; saved files are re-registered

### Agent loop
- [x] Multi-step tool loop with a real step budget
- [x] Tool registry: read/write/patch/list/search/run/remember
- [x] Search/replace patch format with atomic multi-block apply
- [x] Unknown-tool and invalid-JSON recovery
- [x] Rescue of tool calls emitted as fenced JSON
- [x] Repair budget for consecutive failing steps
- [x] Context-overflow healing (prompt trimming + budget shrink)
- [x] Cancellation through `AbortSignal`
- [x] Autopilot and supervised approval modes

### Durability / self-heal
- [x] Append-only JSONL journal with per-entry `fsync`
- [x] Torn-write tolerance on load
- [x] Resume that skips completed steps and replays tool results without re-executing them
- [x] Checkpoint before every mutating tool call
- [x] Checkpoint diff + restore (including removal of files added after the snapshot)
- [x] Checkpoint pruning

### Context engine
- [x] Token estimation independent of tokenizer
- [x] Budgeted assembly with priorities
- [x] Pinned sections (steering, memory) always retained — truncated, never dropped
- [x] History compaction with digest note
- [x] Hard budget invariant enforced after assembly
- [x] Head/tail truncation with explicit marker
- [x] Lexical workspace retrieval to seed context

### Kiro workflow
- [x] `requirements.md` generation (user stories + EARS criteria with R-IDs)
- [x] `design.md` generation (architecture, interfaces, data models, error handling, traceability)
- [x] `tasks.md` generation (hierarchical checkboxes, one repair pass)
- [x] Spec store with per-artifact persistence and progress
- [x] Task execution from the task list; checkbox flips only on success
- [x] Hooks: fileEdited/Created/Deleted, taskCompleted, agentStop, manual → agent or command
- [x] Hook failure isolation
- [x] Steering files with `always` / `auto` / `manual` inclusion
- [x] MCP stdio client (initialize, tools/list, tools/call) with namespaced tools

### API + UI
- [x] HTTP API with SSE for chat, runs, resume, spec generation, task execution
- [x] Single router in `server/http.ts`; `server/index.ts` only boots it
- [x] File CRUD with workspace sandboxing
- [x] Config API (provider, endpoints, model, budget, autonomy, commands)
- [x] Memory API (snapshot, add fact, forget fact)
- [x] React UI: file tree, Monaco editor with local workers, chat transcript, spec panel, hooks
      panel, undo/checkpoint panel, runs panel, models + memory panel, status bar
- [x] Live "LM Studio offline" guidance instead of a dead run button
- [x] Context meter and self-heal notices surfaced in the transcript
- [x] Quick open (`Ctrl/Cmd+P`) over the whole workspace with fuzzy scoring and keyboard navigation
- [x] One Monaco model per path: undo history, cursor and scroll survive tab switches
- [x] Closing a tab with unsaved changes asks before discarding them
- [x] Transcript reducer unwraps the SSE `{ type, step, data }` envelope, so tool names, arguments,
      assistant text and the context meter render instead of blank entries
- [x] Sidebar tab strip wraps instead of clipping tabs on narrow windows

### Documentation / examples
- [x] `README.md` (setup, desktop build, providers, memory, feature map, safety)
- [x] `docs/DESIGN.md` (architecture, module contracts, failure matrix, parity, roadmap)
- [x] `.genie.example/` config, hook and steering samples

---

## 3. Deliberately not done

| Item | Reason |
| --- | --- |
| Code OSS fork (LSP, debugger, extensions) | Out of scope for a web IDE; Monaco covers editing |
| Inline Cmd-K edit with accept/reject diff | Next milestone (see design §8) |
| Per-task verify commands | Roadmap |
| Embedding-based retrieval | Lexical retrieval is implemented; embeddings need a local embeddings endpoint |
| Auto-rollback after failure | Rejected on purpose: silently reverting user edits is worse than failing loudly |
| Bundled provider presets (OpenAI/Groq/…) | The provider option is generic on purpose: any OpenAI-compatible base URL works, so no vendor is hard-coded |

---

## 4. Known limitations

1. **Not validated against a live model in this environment.** Model interactions are covered by
   fetch-level fakes plus a fake MCP child process. The first real run should be watched: tool-call
   formatting varies by model, which is exactly why the rescue path exists.
2. Token estimates are heuristic (`max(chars/4, words×1.3)`), so the budget is conservative but
   not exact; the context-overflow healing path is the safety net.
3. Checkpoints snapshot whole files (1 MB/file, 40 MB total). Very large workspaces will see some
   files skipped, and snapshots are not incremental.
4. Browser interaction was exercised in headless Chromium for the documented flows (quick open,
   file open, an agent run, specs, runs, undo, models), but not against a live LM Studio server:
   the screenshots and the run transcript come from a stub OpenAI-compatible endpoint.
5. `run_command` runs allow-listed commands with your shell privileges. The deny-list is a
   guardrail, not a sandbox.
6. Only the Linux desktop binary was executed. The macOS binary is produced on Linux and is
   **unsigned**, so macOS will kill it until it is ad-hoc signed (`codesign --sign - <binary>`);
   the Windows binary was not run here either.
7. Agent memory is per workspace and plain text. There is no conflict resolution across
   concurrent processes, and no semantic search over facts — the core file is a small pinned list
   by design.

7. The debugger is Node-only and applies no source maps; a script that finishes while the debugger is
   still attached stays `running` until Stop, because Node keeps the debuggee alive.
8. Peek and navigation are JS/TS only: other languages keep editing and highlighting but have no
   semantic navigation, since there is no LSP client.

---

## 5. Next actions

1. Run `npm test` after the first real LM Studio session and add a model-specific regression for
   any tool-call format the rescue path had to fix.
2. Add per-task verification (`> verify: <command>` under each task) so completion requires evidence.
3. Implement Cmd-K inline edit reusing the patch tool with a diff preview.
4. Add token/wall-clock run budgets with a continue gate.
5. Convert checkpoints to content-addressed blobs to cut disk use in large repos.
6. Sign macOS/Windows desktop builds and add a release workflow that uploads the three binaries.
7. Route the debugger through DAP adapters (Python, Go) and apply source maps.
8. Add an LSP client for non-TS languages so peek works everywhere.
9. Add a CI workflow that runs `npm test`, `npm run typecheck` and `npm run build` on every pull
   request, so the gates in `docs/contributing/pull-requests.md` are enforced rather than trusted.
