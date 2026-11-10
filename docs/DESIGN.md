# Anneal — Detailed Design

Status: implemented, tested on Node 24 / LM Studio-compatible endpoints.
Last updated: 2026-10-30.

---

## 1. Problem and goals

Kiro (AWS) showed that an agent is only useful when the work is *specified before it is
generated* and when the agent can survive its own failures. `anneal` rebuilds that workflow for
people who run models locally.

### Goals

1. **Local by default.** Every completion goes to an OpenAI-compatible endpoint, default
   `http://127.0.0.1:1234/v1` (LM Studio). No cloud calls and no telemetry unless you explicitly
   switch the provider to an external API (§3.12).
2. **Spec-driven development.** A feature starts as `requirements.md` (EARS-style, stable R-IDs),
   becomes `design.md` (components, data models, testing), and is broken into `tasks.md`
   (hierarchical checkboxes). Tasks are executed one at a time against that spec.
3. **Self-healing runs.** A transient failure (server restart, timeout, malformed patch, context
   overflow, crash) must not lose the run or duplicate work.
4. **Context that fits.** The prompt must stay inside the model's window by construction, not by
   hoping the model ignores the overflow.
5. **Reversible edits.** Every mutating tool call is preceded by a snapshot that can be diffed and
   restored.

### Non-goals (deliberate)

- A Code OSS fork. That is a multi-year project; `anneal` is a web IDE with a real editor.
- A general language-server platform and multi-runtime debug adapters. Peek/navigation for JS/TS
  comes from Monaco's bundled TypeScript service and debugging from Node's inspector; there is no
  LSP client and no DAP adapter layer.
- Multi-user or remote hosting. The API is loopback-only by design.
- Hosted-provider lock-in. An external OpenAI-compatible endpoint is supported, but no vendor is
  hard-coded or required; the default and supported target is a local model.

---

## 2. Architecture

```
┌──────────────────────────── Browser (React + Monaco) ────────────────────────────┐
│  FileTree · EditorPane · ChatPanel · Specs/Hooks/Undo/Runs panels · StatusBar     │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │  fetch + SSE (text/event-stream)
┌───────────────────────────────▼──────────────────────────────────────────────────┐
│                    server/http.ts (HTTP router, SSE) — index.ts just boots it     │
│                                    │                                              │
│                              service.ts (orchestration)                           │
│      ┌──────────────┬──────────────┼───────────────┬──────────────────┐          │
│      ▼              ▼              ▼               ▼                  ▼          │
│  agent/loop    spec/store+gen   hooks/engine   steering/load     mcp/client      │
│      │              │              │               │                  │          │
│      ├── context/builder ── tokens                                              │
│      ├── agent/journal (JSONL, fsync)                                            │
│      ├── agent/checkpoints (snapshot store)                                      │
│      ├── tools (read/write/patch/list/search/run)  ← path sandbox                │
│      └── llm/client (LM Studio, SSE, retry, breaker)                             │
└──────────────────────────────────────────────────────────────────────────────────┘
                                │  HTTP /v1
                        ┌───────▼────────┐
                        │   LM Studio    │  local model (tool calling)
                        └────────────────┘
```

Everything stateful lives under `.anneal/` in the workspace:

```
.anneal/
  config.json            user config (model, budget, autonomy, commands)
  specs/<id>/{requirements,design,tasks}.md
  runs/<runId>/journal.jsonl
  checkpoints/<id>/{manifest.json,files/…}
  hooks/*.json
  steering/*.md
  mcp.json
```

---

## 3. Module design

### 3.1 `llm/client.ts` — LM Studio adapter

- `POST {baseUrl}/chat/completions` with `stream: true`, `tools`/`tool_choice` when tools exist.
- Parses SSE blocks split on `\n\n`, `data:` lines, `[DONE]`; accumulates `delta.tool_calls` by
  `index` (local models fragment function names and arguments across chunks).
- Falls back to plain JSON when the server ignores `stream`.
- `GET /models` normalizes `max_context_length | loaded_context_length | context_length`.
- Transport policy: `maxAttempts` with exponential backoff + jitter; retryable = 408/409/425/429/5xx,
  `TypeError` (fetch transport), and known socket codes. `AbortError` and 4xx validation errors are
  final.
- **Streaming safety:** if any delta has been delivered, the request is never replayed — a replay
  would duplicate visible text and tool calls.
- `CircuitBreaker` (threshold 3, 15 s) turns a dead server into an immediate, actionable error
  instead of a 2-minute hang.

### 3.2 `agent/loop.ts` — the agent

One step = one model call + zero or more tool calls.

```
for step in [startStep, maxSteps):
  if cancelled → cancelled (resumable)
  if journal has step:<n>:done → skip
  build context  → emit context usage
  call model with healing:
      - transport retries inside client
      - on context overflow: shrinkPrompt(0.4) + reduce budget, retry (≤3)
      - rescue tool calls emitted as fenced JSON
  if no tool calls:
      empty → nudge and count a failure
      otherwise → completed
  for each tool call:
      journaled already? → replay result, do not re-execute
      unknown tool / invalid JSON → structured error to the model
      supervised mode → approval callback
      mutate → beforeWrite → checkpoint
      record tool.result + turn
  journal step.complete
  too many consecutive failing steps → failed (resumable)
```

Messages sent to the model are always `system` (instructions) + optional `user <context>` +
`user/assistant` turns. Tool results are flattened into `<tool_result …>` user turns. This keeps
every request valid for local models that are strict about `tool_call_id` pairing, and it means
history compaction can never produce an orphaned `tool` message.

Idempotency keys: `tool:<step>:<callId>` for results, `step:<n>:done` for steps,
`step:<n>:assistant` for the assistant message. Resume re-reads the journal, rebuilds turns, and
skips anything already recorded.

### 3.3 `agent/journal.ts` — durability

Append-only JSONL, one `fsync` per entry (`open` → `write` → `sync` → `close`). Load tolerates a
torn trailing line (a process killed mid-write) by skipping unparsable lines. The journal is both
the audit log and the resume state.

Event types: `run.start`, `resume`, `context`, `assistant`, `tool.call`, `tool.result`,
`step.complete`, `checkpoint`, `error`, `task.update`, `run.end`.

### 3.4 `agent/checkpoints.ts` — reversibility

Not git-based: git would disturb the user's index/stash and assumes a repository exists. Instead
files are copied to `.anneal/checkpoints/<id>/files/` with a SHA-256 manifest (1 MB/file, 40 MB
total caps; `node_modules`, `.git`, `dist`, `.anneal` excluded). `diff` compares hashes; `restore`
rewrites changed files, recreates deleted ones and removes files added since the snapshot.

### 3.5 `context/builder.ts` — budgeted context

```
prompt budget = max(256, contextBudgetTokens − reserveOutputTokens)
history share = min(0.6, historyShare) × budget          (default 25%)
```

Assembly order:

1. Compact history (newest verbatim, older replaced by a digest note with roles + previews).
2. Pinned sections (always steering) get a fair share each and are truncated, never dropped.
3. Remaining sections by descending priority: whole → truncated → dropped
   (priority: task 88 > requirements 78 > design 74 > active file 60 > retrieval 52 > steering 95 pinned).
4. Final guard loop re-measures and sheds the lowest-priority content until `total ≤ budget`.

`estimateTokens = max(chars/4, words × 1.3)` — intentionally conservative and tokenizer-agnostic;
`truncateToTokens` keeps the head (imports) and tail (recent edits) with an explicit marker.

### 3.6 `tools/` — sandboxed actions

| Tool | Notes |
| --- | --- |
| `read_file` | line-numbered, windowed with `start_line`/`end_line` |
| `write_file` | create/overwrite, 2 MB cap, checkpoint first |
| `apply_patch` | SEARCH/REPLACE blocks, all-or-nothing, unique-match enforcement, whitespace-tolerant fallback |
| `list_files` | tree, ignores `node_modules/.git/dist/.anneal` |
| `search` | regex or literal, glob filter, capped results |
| `run_command` | `bash -lc`, timeout, output caps, deny-list (git push/reset, rm -rf roots, sudo, downloads piped to a shell) |

`resolveInWorkspace` rejects `..`, absolute paths outside the root, NUL bytes and symlink escapes
(realpath of the closest existing ancestor), so a model cannot read or write outside the project.

### 3.7 `spec/` — the Kiro workflow

Generation is three sequential streaming completions with separate system prompts:

- **requirements**: numbered user stories + EARS acceptance criteria with stable `R<n>` IDs, NFRs,
  out of scope.
- **design**: architecture, component signatures, data models, error handling, testing,
  and an R-ID traceability table.
- **tasks**: `- [ ] 1. …` / `  - [ ] 1.1 …` with R-ID references, 10–25 lines, one repair pass if
  the model answers with prose.

Each artifact is persisted before the next stage starts, so a later failure never destroys an
earlier approved document. `parseTasks` / `setTaskChecked` operate on the markdown directly; the
checkbox rewrite touches only the `[ ]` character so numbering and wording stay intact.

### 3.8 `hooks/` — event automation

`{"when": {"type": "fileEdited", "patterns": ["src/**/*.ts"]}, "then": {"type": "agent"|"command", …}}`

Events: `fileEdited`, `fileCreated`, `fileDeleted`, `taskCompleted`, `agentStop`, `manual`.
A failing hook is reported but never blocks other hooks or the run. File writes through the API
emit file events; task completion emits `taskCompleted`; every user-triggered run emits
`agentStop` (hook-triggered runs do not, preventing recursion).

### 3.9 `steering/` — conventions

`.anneal/steering/*.md` with optional frontmatter:

```yaml
---
inclusion: auto        # always | auto | manual
globs: ["src/**/*.ts"]
---
Use tabs. Co-locate tests. Never add a dependency without a note.
```

`always` is pinned into every prompt; `auto` joins when an open/edited file matches; `manual` is
opt-in only.

### 3.10 `mcp/client.ts` — MCP

Newline-delimited JSON-RPC 2.0 over stdio: `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`, per-request timeouts, rejection on server exit. Remote tools are
namespaced `mcp__<server>__<tool>` and appear to the loop as ordinary tools. Servers are only
spawned on an explicit connect request, not automatically.

### 3.11 `memory/` — cross-run agent memory

Three files under `.anneal/memory/`, all plain text so a user can read, edit or delete them:

| File | Written | Read by |
| --- | --- | --- |
| `facts.jsonl` | `addFact` (deduplicated by key, last write wins), `forgetFact` | `renderCore`, the API |
| `core.md` | re-rendered from the fact list on every fact change | the prompt builder |
| `events.jsonl` | one line per finished run (`run.end`), pruned to `maxEvents` (500) | UI counts, future retrieval |

```ts
class AgentMemory {
  addFact({ key, value, tags?, runId? }): Promise<Fact>;
  forgetFact(key: string): Promise<boolean>;
  listFacts(): Promise<Fact[]>;
  readCore(): Promise<string>;
  recordRun({ runId, goal, status, message, steps }): Promise<void>;
  snapshot(): Promise<MemorySnapshot>;
  prune(keep?): Promise<number>;
}
```

Integration points, deliberately few:

1. **Prompt.** `AnnealService.buildSections` prepends `core.md` as a pinned `memory` section
   (priority 96). Pinned sections are truncated, never dropped, so the agent always sees its own
   notes — but the store caps `core.md` at `maxCoreLines` (120) lines so it cannot crowd out the
   workspace.
2. **Tools.** A `remember` tool is appended to the registry in `service.ts`. It is the only write
   path the model has into memory; there is no implicit "summarise the run into facts" step
   because that reliably produced noise.
3. **Runs.** `startRun` records one `run.end` event after every run, so a later run can see what
   was already attempted (`GET /api/memory` exposes the same data).

Failure behaviour: a corrupt line in `facts.jsonl` or `events.jsonl` is skipped, never fatal. A
failed memory write is swallowed for run events and surfaced as a tool error for `remember`.

### 3.12 Provider switch

`resolveEndpoint(config)` is the single place that decides where completions go:

| `provider` | base URL | model | auth |
| --- | --- | --- | --- |
| `lmstudio` (default) | `lmStudioBaseUrl` | `model` | none |
| `external` | `externalBaseUrl` | `externalModel`, falling back to `model` | `Bearer externalApiKey` if set |

Layering is unchanged (defaults ← `.anneal/config.json` ← environment ← overrides), so
`ANNEAL_PROVIDER=external` wins over a stored value and an unknown provider string degrades to
`lmstudio` rather than failing the boot. Because the client only speaks `/chat/completions` with
SSE and tool calls, no per-vendor code exists: the switch is three config fields plus the
`apiKey` the client already supported.

### 3.13 Desktop packaging

`scripts/build-desktop.mjs` turns the app into standalone executables:

1. `vite build` produces `dist/` (SPA + hashed assets).
2. The whole `dist/` tree is copied into `.desktop-pkg-dist/`.
3. A generated entry (`createServer` + signal handling) is bundled with esbuild into
   `dist/bin/anneal-server.cjs` — CommonJS, because `pkg` handles CJS snapshots reliably and it
   removes all runtime module resolution.
4. The staged `package.json` declares `bin` (required by `pkg`) and
   `pkg.assets: ["dist/**/*"]`, so the SPA is snapshotted as data.
5. `@yao-pkg/pkg` is invoked through its local bin (never `npx pkg`, which can resolve the
   abandoned `pkg@5` and cannot target `node24`) for
   `node24-linux-x64,node24-macos-arm64,node24-win-x64`.

The entry resolves assets with `path.join(__dirname, '..')`, which is the snapshot's `dist/`
at runtime and the real `dist/` in a dev checkout. The build then polls for the expected output
paths until their sizes are stable, because `pkg` spawns writers that outlive the parent process;
without that wait the build reported success before the binaries existed.

### 3.14 `debug/session.ts` — Node debugger

`node --inspect-brk=127.0.0.1:0` starts the script paused and prints a WebSocket URL; the session
speaks Chrome DevTools Protocol over it: `Debugger.setBreakpointByUrl`, `Debugger.resume|pause|step*`,
`Runtime.getProperties` for locals and `Debugger.evaluateOnCallFrame` for evaluation.

The ordering is the hard part. Each rule below exists because its absence produced a frozen
debuggee or a status that lied:

1. `Runtime.runIfWaitingForDebugger`, then **wait for the entry pause** before the first
   `Debugger.resume`; resuming while V8 is still waiting is rejected and leaves the program stopped.
2. Set the optimistic `running` status **before** sending a resume: the next breakpoint can be hit
   before the protocol reply arrives, and setting it afterwards overwrites a real pause.
3. Map paused frames through `Debugger.scriptParsed`; call frames carry a `scriptId`, not a URL.
4. Publish a pause immediately (status + frames) and fill locals a tick later behind a sequence
   guard, so a resume landing mid-fetch cannot resurrect a stale frame.

No dependency is needed: Node ≥22 exposes a global `WebSocket`, and older runtimes get a clear
error. Under `pkg` there is no node binary to spawn, and `PKG_EXECPATH=PKG_INVOKE_NODEJS` is
rejected by this bootstrap ("bad option: --inspect-brk"), so the session launches the debuggee with
a real Node install instead (`ANNEAL_NODE` overrides it) and fails with a clear message when absent. `.js` runs directly; `.ts` relies on Node ≥23.6
type stripping (or `--experimental-strip-types`). Paths are resolved inside the workspace, so a
script outside it is rejected before anything is spawned.

### 3.15 `intel/sources.ts` + `src/editor/intel.ts` — peek and navigation

Monaco ships a complete TypeScript language service inside its worker, so navigation needs no LSP
server. The server exposes a bounded bundle of workspace sources (`GET /api/intel/sources`); the
editor registers each as an extra lib under `file:///workspace/<path>` and configures the TS
defaults. Open models use the same URI and take precedence — the lib for that URI is disposed while
the model exists and restored when it closes, which is what avoids duplicate declarations.

One wiring yields go to definition, peek definition, find usages, implementations, hover quick
info, the file outline and inline diagnostics — the peek widget included — for JS/TS. Caps
(600 files, 3 MB, 400 KB per file, `truncated` flag) keep a large repository from turning a
keystroke into a 200 MB download; other languages keep editing without navigation.

---

## 4. Failure matrix (self-heal contract)

| Failure | Detection | Recovery | Idempotency risk |
| --- | --- | --- | --- |
| LM Studio down | `ECONNREFUSED` / `TypeError` | backoff retry, then circuit open with instructions | none (no side effects) |
| 429 / 5xx | status code | retry with jitter | none |
| Timeout mid-stream | `AbortError` from internal timeout | retry only if no delta emitted | none |
| User cancel | `AbortSignal` | journal `error`, status `cancelled`, resumable | none |
| Context overflow (400) | message/status heuristic | trim prompt 0.4, shrink budget, retry ≤3 | none |
| Malformed tool JSON | `JSON.parse` | error turn, model retries | none |
| Patch does not match | `PatchError` | error turn with file-state advice | none (nothing written) |
| Write tool throws | exception | error turn, run continues | possible partial file → checkpoint restore |
| Process crash | missing `run.end` | resume from journal, skip finished keys | tool results replayed from journal |
| Repeated step failure | `consecutiveFailures > maxToolRepairs` | fail fast, keep journal, expose Resume | n/a |

Deliberate limitation: `anneal` never auto-restores a checkpoint behind your back. Destructive
rollback is an explicit action in the Undo panel.

---

## 5. Security model

- HTTP API binds `127.0.0.1`; CORS is not enabled. It is not a hosted service.
- All paths pass through `resolveInWorkspace` (including symlink resolution).
- Commands: opt-in, timeout-bound, deny-listed, run with the user's own shell privileges. The
  agent cannot `git push`, hard-reset or run `sudo`.
- MCP servers are user-configured executables; they inherit the environment. Connect explicitly.
- Checkpoints are workspace-local copies, never uploaded.

---

## 6. Testing strategy

Unit and integration tests run under Vitest with real temp directories and a fake LM Studio
(fetch-level fakes, a fake MCP child process, and a spawned API server). No test requires a real
model.

| Area | Test file | Key assertions |
| --- | --- | --- |
| Retry/backoff/breaker | `retry.test.ts` | exponential caps, non-retryable stop, half-open probe |
| Tokens/context | `context.test.ts` | budget never exceeded, priority order, pinned truncation, compaction |
| Paths/patch | `paths-patch.test.ts` | traversal/absolute/symlink rejection, atomic multi-block patch, ambiguity refusal |
| Durability | `journal-checkpoints.test.ts` | torn-line tolerance, ordered replay, diff/restore/prune |
| Hooks/steering/spec | `hooks-steering-spec.test.ts` | glob semantics, failure isolation, frontmatter, task parsing/toggle |
| LM Studio protocol | `llm-client.test.ts` | SSE assembly, tool-call fragmentation, retry policy, no replay after deltas, JSON repair |
| Agent loop | `agent-loop.test.ts` | tool execution + checkpoints, resume without replay, patch repair, context shrink, cancel, step budget, unknown tools |
| Tools | `tools.test.ts` | sandbox escapes, beforeWrite, search/glob, command deny-list |
| MCP | `mcp.test.ts` | initialize/list/call over stdio, config validation |
| HTTP API | `http-api.test.ts` | live server: health offline, file CRUD, 400 on escape, specs, checkpoints |
| Agent memory | `memory.test.ts` | fact dedup by key, forget, core rendering + line cap, event ordering/pruning, empty store |
| Provider switch | `provider.test.ts` | local default, external from env, external from config.json, local-model fallback, unknown provider degrades |
| Language service | `intel.test.ts` | source filters, ignored dirs, file/size caps, truncation |
| Debugger | `debug.test.ts` | breakpoint pause, locals, in-frame evaluation, stepping, missing/escaping script rejection |

---

## 7. Kiro parity and gaps

| Kiro feature | Anneal | Notes |
| --- | --- | --- |
| Specs (requirements/design/tasks) | ✅ | Same three artifacts, EARS requirements, R-ID traceability |
| Task execution from `tasks.md` | ✅ | Checkbox only flips on success |
| Agent hooks | ✅ | `fileEdited/Created/Deleted`, `taskCompleted`, `agentStop`, `manual` |
| Steering files | ✅ | `always`/`auto`/`manual` with globs |
| Agent autonomy modes | ✅ | Autopilot and supervised approval |
| Checkpoints / restore | ✅ | Snapshot store with diff + restore |
| MCP tool servers | ✅ | stdio client, tool namespacing |
| Inline diff / apply on hover | ⚠️ | Patch results are shown in chat; no inline accept/reject UI |
| Inline chat / quick edit (Cmd-K) | ❌ | Planned |
| Code OSS editor: extensions, extension marketplace | ❌ | Monaco only; out of scope |
| Debugger (breakpoints, step, variables, evaluate) | ✅ | Node inspector via CDP; other runtimes need DAP |
| Peek/navigation (definition, usages, hover, outline) | ✅ | Monaco TS service over the workspace; JS/TS only |
| Autonomous "agent runs tests until green" | ⚠️ | Agent can run tests; no dedicated loop budget |
| Model routing between providers | ✅ | `provider` switch: LM Studio or any OpenAI-compatible API |
| Cross-run agent memory | ⚠️ | Pinned facts + run journal; no semantic recall over events |

---

## 8. Roadmap

1. Inline edit (Cmd-K) using the same agent tools with a diff preview.
2. Per-task verification commands in `tasks.md` (`> verify: npm test`) executed automatically.
3. Embedding-based retrieval (optional local embedding endpoint) to complement lexical search.
4. Run budgets: token and wall-clock caps with a cost-free "continue?" gate.
5. Streaming checkpoint deltas instead of full snapshots for large workspaces.
6. Sign the macOS/Windows desktop builds and publish them from CI.
7. Semantic recall over `events.jsonl` once a local embedding endpoint is available.
8. Debug adapters (DAP) for Python/Go and source-map support in the Node session.
