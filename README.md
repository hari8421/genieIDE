# genie

A local-first, spec-driven agentic IDE in the spirit of Kiro — but every model call goes to
**your own LM Studio server**. No cloud account, no API keys, no telemetry.

```
requirements.md  →  design.md  →  tasks.md  →  agent executes task-by-task
```

## Why it exists

Kiro's value is not the text editor; it is the workflow around the model: a spec that forces
requirements before code, hooks that automate the boring parts, steering files that keep the
model aligned with your conventions, checkpoints you can roll back, and an agent loop that
does not fall over when one run goes wrong. `genie` implements that workflow against a local
OpenAI-compatible endpoint.

## Feature map

| Capability | Status | Where |
| --- | --- | --- |
| Spec generation (requirements → design → tasks) | ✅ | `server/spec/generator.ts` |
| Task-by-task execution with checkbox tracking | ✅ | `server/service.ts`, `server/spec/spec.ts` |
| LM Studio models (list, switch, context length) | ✅ | `server/llm/client.ts` |
| Streaming chat + streaming agent events (SSE) | ✅ | `server/llm/client.ts`, `server/index.ts` |
| Tool use: read, write, patch, list, search, run | ✅ | `server/tools/index.ts` |
| Resumable runs after a crash or cancel | ✅ | `server/agent/journal.ts`, `server/agent/loop.ts` |
| Self-healing: retry, backoff, context shrink, repair loop | ✅ | `server/agent/loop.ts`, `server/llm/retry.ts` |
| Checkpoints + diff + restore before every write | ✅ | `server/agent/checkpoints.ts` |
| Agent hooks (file/task/stop events → agent or shell) | ✅ | `server/hooks/hooks.ts` |
| Steering files (`always` / `auto` / `manual`) | ✅ | `server/steering/steering.ts` |
| MCP client (stdio, tools/list, tools/call) | ✅ | `server/mcp/client.ts` |
| Context budgeting, history compaction, retrieval | ✅ | `server/context/*` |
| Autopilot vs supervised tool approval | ✅ | `server/agent/loop.ts` |
| Local Monaco editor with bundled workers (works offline) | ✅ | `src/monaco-setup.ts` |
| LSP, debugger, extension marketplace, inline ghost text | ❌ | out of scope (needs Code OSS fork) |

Full parity notes and known gaps: [docs/DESIGN.md](docs/DESIGN.md). Build status:
[PROGRESS.md](PROGRESS.md).

## Requirements

- Node.js 20 or newer (tested on 24)
- [LM Studio](https://lmstudio.ai) with a tool-calling capable model (e.g. Qwen2.5-Coder,
  Llama 3.1/3.3 Instruct, Devstral)

## Quick start

```bash
npm install

# 1. In LM Studio: load a model, then start the local server (default port 1234).

# 2. Point genie at it (defaults already match LM Studio).
cp .genie.example/config.json .genie/config.json        # optional, edit model id
mkdir -p .genie/hooks .genie/steering
cp -r .genie.example/hooks/* .genie/hooks/              # optional
cp -r .genie.example/steering/* .genie/steering/        # optional

# 3. Run it
npm run dev        # API on :8787, UI on :5173
```

Open <http://127.0.0.1:5173>. The status bar shows whether LM Studio is reachable; the model
dropdown is populated from `GET /v1/models`.

Production mode (single process serving the built UI):

```bash
npm run build
npm start          # http://127.0.0.1:8787
```

### Using a different host/port for LM Studio

`.genie/config.json`:

```json
{ "lmStudioBaseUrl": "http://192.168.1.20:1234/v1", "model": "qwen2.5-coder-14b-instruct" }
```

or environment variables: `LMSTUDIO_BASE_URL`, `GENIE_MODEL`, `GENIE_CONTEXT_BUDGET`,
`GENIE_AUTONOMY=supervised`, `GENIE_MAX_STEPS`, `GENIE_MAX_ATTEMPTS`, `GENIE_ALLOW_COMMANDS`.

## Daily use

1. **Specs tab** — create a spec, describe the feature, hit *Generate spec*. You get
   `requirements.md`, `design.md`, `tasks.md` in `.genie/specs/<id>/`. Edit them; they are plain
   markdown and the agent reads them as high-priority context.
2. **Run next task** — the agent implements the next unchecked task, and checks it off only when
   the run completes. Every task run gets a fresh context window.
3. **Chat** — free-form agent runs. Tick files in the tree to pin them into context.
4. **Undo tab** — a snapshot is taken before every mutating tool call. Diff or restore it.
5. **Runs tab** — every run is journaled. Resume an interrupted run; completed steps and tool
   calls are not replayed.

## How the self-healing works

| Failure | Behaviour |
| --- | --- |
| LM Studio 5xx / 429 / socket error | Exponential backoff + jitter, up to `maxAttempts`, then a circuit breaker fails fast |
| Tokens already streamed | Never retried, so output is not duplicated |
| Prompt exceeds the context window | Context is trimmed to 40%, the budget shrinks, the same step retries (max 3) |
| Tool returns an error | The error is fed back to the model with a repair budget (`maxToolRepairs`) |
| Tool arguments are not JSON | Rejected with a precise message instead of crashing the step |
| Model emits a tool call as fenced JSON | Rescued into a real tool call |
| Process crash / cancel | Step and tool results are fsync'd to `journal.jsonl`; resume skips finished work |
| Agent run fails | Status is `failed` with `resumable: true`, never a silent partial success |

## Repository layout

```
server/
  agent/        loop.ts (the agent), journal.ts (durability), checkpoints.ts, patch.ts, prompts.ts
  context/      builder.ts (budgeting), retrieval.ts (lexical search)
  llm/          client.ts (LM Studio), retry.ts, structured.ts
  tools/        sandboxed file/shell tools
  spec/         spec store + three-stage generator
  hooks/        event → action engine
  steering/     project convention files
  mcp/          minimal stdio MCP client
  service.ts    orchestration
  index.ts      HTTP + SSE API
src/            React + Monaco UI
tests/          vitest suite (93 tests)
docs/DESIGN.md  detailed design
PROGRESS.md     what is done, what is not
```

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # typecheck + vite production build
```

The suite covers retry/backoff/circuit breaking, token budgeting invariants, history
compaction, patch atomicity, path-escape rejection (including symlinks), journal durability with
torn writes, checkpoint restore, hook dispatch isolation, spec task parsing, LM Studio SSE
streaming and tool-call assembly, agent resume without replaying tools, context-overflow
healing, MCP stdio round-trips, and a live HTTP integration test against a temp workspace.

## Safety

- The API binds to `127.0.0.1` by default; it is meant to run on your machine.
- All file paths are resolved inside the workspace; `..`, absolute paths and escaping symlinks
  are rejected.
- Shell commands run only when `allowCommands` is true, with a timeout, and destructive
  patterns (`git push`, `git reset --hard`, `rm -rf /`, `sudo`, piping downloads into a shell)
  are blocked. The agent cannot push your code.
- Checkpoints are taken before writes, so an unwanted edit can be reverted from the UI.
