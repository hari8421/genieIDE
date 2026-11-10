# Development

## Requirements

- Node.js 20 or newer (CI runs 22)
- npm (the repo commits `package-lock.json`; `npm ci` is the supported install)
- LM Studio only if you want a real model run. Tests, typecheck, build and most UI work do not
  need it.

## Setup

```bash
npm ci
npm run dev
```

`npm run dev` (see `scripts/dev.mjs`) starts two processes and prefixes their logs:

| Process | Port | Notes |
| --- | --- | --- |
| API (`server/index.ts`, via tsx) | `8787` | bound to `127.0.0.1` |
| Web (`vite`) | `5173` | bound to `0.0.0.0`, proxies `/api` to the API |

Open <http://127.0.0.1:5173>. The status bar turns green when the configured model endpoint
answers; the model dropdown is populated from `GET /models` on that endpoint.

Useful overrides while developing:

```bash
ANNEAL_PORT=9000 npm run dev        # move the API
ANNEAL_WEB_PORT=4000 npm run dev    # move the UI
ANNEAL_WORKSPACE=/path/to/repo npm run dev   # point the agent at another folder
```

### Production mode

```bash
npm run build   # typecheck + vite build → dist/
npm start       # one process serves the API and dist/ on :8787
```

### Desktop executables

```bash
npm run build-desktop            # pkg binaries in pkg-out/anneal/
ANNEAL_DESKTOP_TARGETS=node24-linux-x64 npm run build-desktop   # one target only
```

## Working without a model

Most UI work needs *a* model endpoint, not a good one. Any OpenAI-compatible server works:

```bash
ANNEAL_PROVIDER=external \
ANNEAL_EXTERNAL_BASE_URL=https://api.openai.com/v1 \
ANNEAL_EXTERNAL_MODEL=gpt-4o-mini \
ANNEAL_EXTERNAL_API_KEY=sk-… \
npm run dev
```

`tests/provider-memory.e2e.test.ts` contains a ~60-line stub server that streams text and tool
calls; copy it into a scratch file when you need an offline endpoint. Keep keys in the environment
(`ANNEAL_EXTERNAL_API_KEY`) or in the git-ignored `.anneal/config.json`, never in a tracked file.

## Where things live

```
server/
  http.ts        the single router (API + SSE + static dist); dev and desktop share it
  index.ts       boots http.ts
  service.ts     orchestration: runs, specs, hooks, memory, config
  agent/loop.ts  the agent loop: steps, tools, healing, journal, checkpoints
  agent/journal.ts, checkpoints.ts, patch.ts, prompts.ts
  context/       budgeted prompt assembly and lexical retrieval
  llm/           OpenAI-compatible client, retry/backoff, structured output
  tools/         read_file, write_file, apply_patch, list_files, search, run_command, remember
  spec/          spec store + requirements → design → tasks generator
src/
  App.tsx        layout, shortcuts, session wiring
  components/    FileTree, EditorPane, ChatPanel, Panels (specs/hooks/undo/runs/models), DebugPanel, QuickOpen
  lib/session.ts SSE event → transcript reducer (the wire format lives here)
  editor/intel.ts Monaco language-service plumbing for peek/navigation
tests/           vitest suite
```

Data written at runtime lives under `.anneal/` in the workspace and is git-ignored:
`config.json`, `specs/`, `runs/<id>/journal.jsonl`, `checkpoints/`, `hooks/`, `steering/`,
`memory/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + Vite with log prefixes |
| `npm test` | full vitest suite |
| `npm run test:watch` | vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck, then `vite build` into `dist/` |
| `npm start` | serve API + `dist/` on `:8787` |
| `npm run build-desktop` | build, bundle the server with esbuild, then `pkg` three binaries |

`.github/workflows/ci.yml` runs `npm ci` plus these three gates on every push to `main` and every
pull request into it, so a broken change shows up on the PR. Branch protection on `main` is what
makes a red run block the merge. Either way, run the gates locally first to shorten the loop.

## How to add things

**A new agent tool.** Implement it in `server/tools/index.ts` with a JSON-schema `parameters`
block, add it to the registry, and cover it in `tests/tools.test.ts` (path safety, arguments,
error messages). Tools run with the user's privileges; validate and bound everything.

**A new API route.** Add it in `server/http.ts` with `route(method, pattern, handler)` and cover it
in `tests/http-api.test.ts`, which drives a real HTTP server against a temp workspace.

**A new UI panel.** Add the component under `src/components/`, mount it from `App.tsx`, and add its
styles to `src/styles.css`. Keep the existing look: dark panels, 12px body text, `.btn`, `.pill`
and `.list-item` primitives rather than new one-off styles.

**Anything that changes an SSE event.** The server emits `{ type, step, data }` envelopes; `result`
and `error` are sent unwrapped. Update `src/lib/session.ts` **and**
`tests/session.test.ts` together — a mismatch there blanks the transcript without failing any
server test.

## Conventions

- Strict TypeScript, no `any` escapes, no unused parameters.
- Prefer small modules with an explicit interface over a growing `service.ts`.
- Comments explain intent and trade-offs; they do not narrate the next line.
- Errors that reach the user should say what failed and what to do next.
- Anything that touches disk is journaled or checkpointed; anything that touches the network has a
  timeout and a bounded retry.
- Keep the README and `PROGRESS.md` honest: if something is not verified, say so.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on 8787 / 5173 | another dev server is running: stop it, or set `ANNEAL_PORT` / `ANNEAL_WEB_PORT` |
| UI shows “LM Studio offline” | nothing is answering at the configured base URL; start LM Studio or switch provider in the **Models** tab |
| Model listed but runs fail | the loaded model does not support tool calls; pick a tool-calling model |
| Vite rejects a tunnel/preview host with `Blocked request` | start the dev script with `ANNEAL_PREVIEW_HOST=your.host`; it is passed to Vite as `server.allowedHosts` |
| `tests/http-api.test.ts` expects health to be offline | something is running on `127.0.0.1:1234`; stop it before running the suite |
| Debugger never leaves `running` | the debuggee finished but Node keeps it alive; press Stop |
