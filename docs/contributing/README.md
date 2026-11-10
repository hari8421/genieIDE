# Contributing to Anneal

Anneal is a local-first IDE, so a contribution should work **without** any cloud account, API key
or telemetry. Everything here runs on your machine against LM Studio (or any OpenAI-compatible
endpoint you point it at).

| Guide | Read it when |
| --- | --- |
| [development.md](development.md) | you are setting up the repo, running the app or writing code |
| [pull-requests.md](pull-requests.md) | you are ready to open, update or merge a pull request |

## The short version

```bash
git clone https://github.com/hari8421/genieIDE.git
cd genieIDE
npm ci                 # install exactly what package-lock.json pins

npm run dev            # API on :8787, UI on :5173 → http://127.0.0.1:5173
npm test               # vitest, 100+ tests, no model server required
npm run typecheck      # tsc --noEmit
npm run build          # typecheck + production bundle
```

You do **not** need LM Studio to run the tests, to typecheck, to build, or to work on the UI.
You need it only when you want a real agent run (see
[development.md#working-without-a-model](development.md#working-without-a-model)).

## Ground rules

1. **One concern per pull request.** A fix plus a refactor plus a rename is three PRs.
2. **Tests come with behaviour.** Bug fixes get a regression test that fails without the fix;
   new server behaviour gets a test that drives it through `server/http.ts` or the module's real
   entry point. The suite already starts real HTTP servers and child processes — follow that style
   instead of mocking the world.
3. **No new runtime dependency without a note in the PR** explaining why the existing code cannot
   do the job. The project deliberately ships a small dependency set.
4. **Respect the local-first contract.** No telemetry, no remote calls that are not the model
   endpoint the user configured, and never a key written into a tracked file. `.anneal/` is
   git-ignored and must stay that way.
5. **Strict TypeScript.** `strict`, `noUnusedLocals` and `noUnusedParameters` are on; `any` is not
   the answer. Comments should explain *why*, not restate the code.

## Before you push

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes (it re-runs typecheck, then bundles the UI)
- [ ] A bug fix has a regression test; a feature has coverage at its real boundary
- [ ] README / `docs/` describe any user-visible change (a new tab, shortcut, env var or API route)
- [ ] No `.anneal/`, `dist/`, `pkg-out/`, secrets or editor noise in the diff (`git status` is clean
      apart from what you meant to commit)
- [ ] The PR template is filled in

Then follow [pull-requests.md](pull-requests.md).
