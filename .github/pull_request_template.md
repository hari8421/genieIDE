## What and why

<!-- The problem in one or two sentences, then what this change does about it. -->

## How it was verified

<!-- Exact commands and their result; add screenshots for UI changes. -->

- [ ] `npm test` — … tests passing
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] Manual check (describe: with LM Studio, with an external provider, or not possible here)

## Risk

<!-- What could break? Anything deliberately left out of scope? -->

## Checklist

- [ ] One concern in this PR
- [ ] Bug fixes include a regression test; new behaviour is covered at its real boundary
- [ ] User-visible changes are reflected in `README.md` / `docs/` / `PROGRESS.md`
- [ ] No `.genie/`, `dist/`, `pkg-out/`, keys or editor noise in the diff
- [ ] No new runtime dependency, or the reason is explained above
