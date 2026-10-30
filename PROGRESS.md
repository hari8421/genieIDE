# genie — Progress

Last updated: 2026-10-30
Branch: `main`
Stage: **M1 complete — local agentic IDE with spec workflow, self-healing runs and reversible edits.**

---

## 1. Verification snapshot

| Gate | Command | Result |
| --- | --- | --- |
| Unit + integration tests | `npm test` | **10 files, 93 tests passing** |
| Type safety | `npm run typecheck` (`tsc --noEmit`) | passing |
| Production bundle | `npm run build` (typecheck + `vite build`) | passing |
| HTTP smoke test | built server + `/api/health`, `/api/files` | passing |
| Real LM Studio end-to-end | requires a local model | **not verified here** — no model server exists in the cloud runner |

The suite is not a smoke test: it starts a real API server against a temporary workspace, spawns
a real MCP child process, and drives the agent loop through success, tool failure, context
overflow, cancellation and resume paths.

---

## 2. What is implemented

### Model layer
- [x] OpenAI-compatible client for LM Studio (`server/llm/client.ts`)
- [x] SSE streaming with incremental assistant text
- [x] Tool-call assembly from fragmented deltas
- [x] Model discovery with context length (`GET /models`)
- [x] Retry with exponential backoff + jitter, retryable-vs-final classification
- [x] Circuit breaker with half-open probe
- [x] No replay after tokens have streamed
- [x] JSON repair loop for structured output (`server/llm/structured.ts`)

### Agent loop
- [x] Multi-step tool loop with a real step budget
- [x] Tool registry: read/write/patch/list/search/run_command
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
- [x] Pinned steering always retained (truncated, never dropped)
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
- [x] File CRUD with workspace sandboxing
- [x] Config API (model, base URL, budget, autonomy, commands)
- [x] React UI: file tree, Monaco editor with local workers, chat transcript, spec panel, hooks panel, undo/checkpoint panel, runs panel, status bar
- [x] Live "LM Studio offline" guidance instead of a dead run button
- [x] Context meter and self-heal notices surfaced in the transcript

### Documentation / examples
- [x] `README.md` (setup, usage, feature map, safety)
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
| Cloud model providers | Local-first by design |

---

## 4. Known limitations

1. **Not validated against a live model in this environment.** Model interactions are covered by
   fetch-level fakes plus a fake MCP server. The first real run should be watched: tool-call
   formatting varies by model, which is exactly why the rescue path exists.
2. Token estimates are heuristic (`max(chars/4, words×1.3)`), so the budget is conservative but
   not exact; the context-overflow healing path is the safety net.
3. Checkpoints snapshot whole files (1 MB/file, 40 MB total). Very large workspaces will see some
   files skipped, and snapshots are not incremental.
4. Browser interaction (clicks, editor typing) was not exercised here; the API and bundle are
   verified, the visuals are not.
5. `run_command` runs allow-listed commands with your shell privileges. The deny-list is a
   guardrail, not a sandbox.

---

## 5. Next actions

1. Run `npm test` after the first real LM Studio session and add a model-specific regression for
   any tool-call format the rescue path had to fix.
2. Add per-task verification (`> verify: <command>` under each task) so completion requires evidence.
3. Implement Cmd-K inline edit reusing the patch tool with a diff preview.
4. Add token/wall-clock run budgets with a continue gate.
5. Convert checkpoints to content-addressed blobs to cut disk use in large repos.
