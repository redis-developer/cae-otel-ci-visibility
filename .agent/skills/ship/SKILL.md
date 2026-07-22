---
name: ship
description:
  Run the full CI gate locally (format, lint, typecheck, test, bundle) and
  verify the committed dist/ is in sync before committing or opening a PR. Use
  whenever you've changed src/ and are about to commit, push, or open a PR — or
  when CI's "Check dist/" or "Continuous Integration" jobs are failing and you
  need to reproduce them locally.
---

# ship

Reproduce every CI gate locally so a green run here means a green run in GitHub
Actions.

## Why this exists

GitHub Actions executes the committed `dist/index.js` (`action.yml` →
`main: dist/index.js`), **not** the TypeScript source. `dist/` is checked into
git, and `.github/workflows/check-dist.yml` fails the build if the committed
bundle differs from a fresh `npm run bundle`. The classic failure: edit `src/`,
tests pass, PR opens green on tests — then `check-dist` rejects it because
nobody rebuilt and staged `dist/`. This skill closes that gap and runs the rest
of the `ci.yml` gate too.

## Steps

Run from the repo root. Stop and report at the first failing gate — don't push
past a red step.

1. **Build + core gate.** Run `npm run all` (this is `format:write` → `lint` →
   `test` → `coverage` → `package`, so it regenerates `dist/` as the last step).
   - If lint or tests fail, fix the source and re-run. Do not edit `dist/` by
     hand — it is generated.

2. **Typecheck.** Run `npm run typecheck`. CI doesn't run this separately, but
   it's cheap and catches type errors that `ts-jest` can miss.

3. **Verify dist/ is in sync** — this is the gate CI enforces. Run the exact
   `check-dist.yml` assertion:

   ```bash
   git add -A dist/
   if [ -n "$(git diff --cached --ignore-space-at-eol --text dist/)" ] || [ -n "$(git status --porcelain dist/)" ]; then
     echo "dist/ changed — staging it (this is expected after a src/ change)"
   else
     echo "dist/ already in sync"
   fi
   ```

   The point: after `npm run all`, the committed `dist/` must match the freshly
   built bundle. If `dist/` changed, **stage it** so it lands in the same commit
   as the `src/` change. If you skip this, `check-dist` will fail the PR.

4. **Report.** Summarize each gate as pass/fail and state explicitly whether
   `dist/` was modified and staged. Map the result to the CI jobs:
   `format:check` + `lint` + `ci-test` = the "Continuous Integration" job; the
   dist sync = the "Check dist/" job.

## Notes

- Don't commit or push unless the user asked — this skill verifies and stages,
  it doesn't ship to remote. The name refers to "ready to ship," not "push for
  me."
- Node 24+ is required (`.node-version` pins `24.4.0`). If `npm run all` fails
  with engine errors, surface that rather than working around it.
- The "Self Report Metrics" step in `ci.yml` runs the action against real OTLP
  and needs a secret; it can't be reproduced locally and is out of scope for
  this skill.
