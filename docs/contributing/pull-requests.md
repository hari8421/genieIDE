# Pull requests

This is the whole path from a clean clone to a merged change.

## 1. Fork and branch

```bash
# once, if you do not have push access to the repository
gh repo fork hari8421/genieIDE --clone      # or: fork on GitHub, then clone your fork

cd genieIDE
git remote -v                                # origin = your fork, upstream = hari8421/genieIDE
git checkout -b fix/transcript-empty-tool-name main
```

Branch names are `<kind>/<short-slug>` with `kind` one of `feat`, `fix`, `docs`, `test`,
`refactor`, `chore`:

- `feat/quick-open`
- `fix/session-event-unwrap`
- `docs/pr-guide`

Keep the branch focused on one concern. If you notice an unrelated bug, open a separate PR for it.

## 2. Do the work

- Write the change, then write or update the test that proves it.
- Run the gates locally (there is no CI workflow yet):

```bash
npm test
npm run typecheck
npm run build
```

- If the change is user-visible, update `README.md` or the relevant file in `docs/`. Screenshots
  live in `docs/images/` and are referenced with a relative path.
- If you change behaviour described in `PROGRESS.md`, update the affected line instead of leaving
  the document claiming something that is no longer true.

## 3. Commit

One logical change per commit; a body that explains *why* when the reason is not obvious.

```bash
git add server/agent/loop.ts tests/agent-loop.test.ts
git commit
```

```
Unwrap SSE envelopes before reducing the transcript

The server sends { type, step, data } but the reducer read fields from the
top level, so tool names and assistant text rendered empty. Unwrap once in the
reducer and add a regression test for both shapes.
```

Rules of thumb:

- Imperative subject line, no trailing period, ideally under 72 characters.
- Do not commit `.genie/`, `dist/`, `pkg-out/`, logs, API keys or `node_modules`.
- Rebase onto `main` rather than merging it into your branch: `git fetch upstream && git rebase upstream/main`.

## 4. Open the pull request

```bash
git push -u origin fix/transcript-empty-tool-name
gh pr create --web            # or open the link GitHub prints
```

Target `main` on `hari8421/genieIDE`. The PR template (`.github/pull_request_template.md`) asks
for four things:

1. **What and why** — the problem, in one or two sentences, and what the change does about it.
2. **How you verified it** — the exact commands you ran and what they printed (`npm test` count,
   `npm run build`, a manual check with LM Studio). Screenshots for UI changes.
3. **Risk** — what could break, and what you deliberately did not touch.
4. **Checklist** — tests, typecheck, build, docs, no secrets.

Keep the title in the same style as a commit subject; it becomes the merge commit message.

## 5. Review

- Push more commits to the same branch; the PR updates automatically.
- Answer review comments with a change or a reason. If you push after a review, say what changed:
  “unwrapped in the reducer instead of every case” beats “done”.
- A reviewer may ask for the PR to be split. That is normal for mixed fixes.

### What reviewers check

| Area | What they look for |
| --- | --- |
| Correctness | the bug the PR claims to fix is actually reproducible before, and gone after |
| Tests | the new test fails without the change; no assertion was weakened to make it pass |
| Contract | SSE shapes, API routes and `.genie/` file formats match the UI and the docs |
| Safety | path escapes rejected, commands still bounded, no secret or telemetry added |
| Scope | unrelated refactors, formatting churn and dependency bumps are not mixed in |
| Docs | README / `docs/` / `PROGRESS.md` agree with the code |

## 6. Merge

- The maintainer merges (squash or rebase) once the checklist is green and the review is resolved.
- Delete the branch afterwards.
- If your PR changed something a user follows, check that `README.md` links and screenshots still
  point at files that exist.

## If something goes wrong

| Situation | Do this |
| --- | --- |
| Your branch fell behind `main` | `git fetch upstream && git rebase upstream/main`, resolve, `git push --force-with-lease` |
| You committed a secret | rotate the key first, then remove it from history; do not just delete the line |
| You committed `.genie/` or `dist/` | `git rm -r --cached .genie dist`, commit the removal, confirm `.gitignore` covers it |
| A test fails only on your machine | check for a local model server on `:1234` (the API health test expects it to be offline) and for stale `dist/` output |
