# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Overview

This is a **GitHub Action** (TypeScript, ESM, Node 24+) that reads JUnit XML test
result files and ships low-cardinality OpenTelemetry metrics over **OTLP/HTTP** to
a metrics backend (Prometheus/Mimir/Grafana Cloud). The single emitted metric is a
gauge `cae.v13.test_duration_seconds` recording per-test duration, designed for
performance-regression detection. See `README.md` for the published input/metric contract.

## Commands

```bash
npm run all          # format:write + lint + test + coverage + package — run before committing
npm test             # Jest (ESM via --experimental-vm-modules)
npm run ci-test      # same as test; used in CI
npx jest src/metrics-generator.test.ts          # run a single test file
npx jest -t "generateTestId"                     # run tests matching a name
npm run test:update:snapshot                      # update Jest snapshots
npm run lint         # ESLint (flat config, type-aware via tsconfig.eslint.json)
npm run format:write # Prettier (no-semi, single quotes, no trailing comma)
npm run typecheck    # tsc --noEmit
npm run package      # Rollup bundle src/index.ts -> dist/index.js
npm run bundle       # format:write + package (what check-dist.yml verifies)
npm run local-action # run the action locally via @github/local-action + .env
```

To run locally: copy `.env.self-check` (or `.env.example`) and run
`npx @github/local-action . src/main.ts .env.self-check` (requires `test-results/*.xml`,
so run `npm test` first to generate them).

## Critical: `dist/` is committed and CI-enforced

GitHub Actions runs `dist/index.js` directly (see `action.yml` -> `main: dist/index.js`),
**not** the TypeScript source. The `dist/` directory is committed to git, and
`.github/workflows/check-dist.yml` fails the build if the committed `dist/` differs from a
fresh `npm run bundle`. **After any change under `src/`, run `npm run bundle` and commit the
regenerated `dist/`** or CI will reject the PR.

## Architecture

The action runs as a linear pipeline orchestrated by `src/main.ts` (`run()`):

1. **`src/junit-parser.ts`** — `ingestDir(folder)` reads every `.xml` file, parses each with
   `fast-xml-parser`, and merges them into one `TJUnitReport`. Parsing is hardened (size cap,
   DOCTYPE/ENTITY rejection, nesting-depth limit, `__proto__`/`constructor` property
   filtering, string truncation). Handles nested `<testsuite>` recursively and falls back to
   wrapping multi-root XML in `<testsuites>`.
2. **`src/metrics-generator.ts`** — `generateMetrics(report, config)` flattens suites/tests
   into `TMetricDataPoint[]`. Each test becomes one gauge data point with a deterministic
   `test.id` (`generateTestId`: abbreviated `suite.class.test` name + 6-char SHA-256 hash for
   uniqueness) plus base attributes (`vcs.repository.*`, `ci.run.id`).
3. **`src/metrics-submitter.ts`** — `MetricsSubmitter` records data points against an
   OpenTelemetry `Meter`, lazily creating instruments keyed by name and prefixing them
   `{namespace}.{version}.{metricName}`. Supports gauge/histogram/counter/updowncounter
   (only gauge is currently emitted).
4. Back in `main.ts`, a `MeterProvider` with a `PeriodicExportingMetricReader` +
   `OTLPMetricExporter` (cumulative temporality) flushes via `forceFlush()`.

**Error handling convention:** parser/ingest functions return a discriminated
`TResult<T> = TOk<T> | TErr<string>` (`{ success: true, data }` / `{ success: false, error }`)
rather than throwing. Check `.success` before using `.data`.

**Export-failure detection:** OTel export errors don't throw. `main.ts` installs a custom
`CapturingDiagLogger` over the OTel diag channel and, after flush, scans captured output for
`"metrics export failed"` to decide `core.setFailed`.

## Conventions & gotchas

- **ESM with NodeNext resolution**: all relative imports must use the `.js` extension even
  for `.ts` files (e.g. `import { run } from './main.js'`).
- **Namespace/version are hardcoded** in `main.ts` (`'cae'` / `'v13'`), not read from inputs.
  `action.yml` only defines three inputs: `junit-xml-folder`, `otlp-endpoint`, `otlp-headers`.
  The `metrics-namespace`/`metrics-version` inputs mentioned in `README.md` are not wired up.
- Interface/type names are prefixed `T` (`TSuite`, `TMetricDataPoint`, `TResult`).
- Jest config uses `ts-jest` with `tsconfig.eslint.json`; test fixtures live in
  `src/__test-fixtures__/` and snapshots in `src/__snapshots__/`.
- Releases are tagged via `script/release` (bump `package.json` version first; it also moves
  the major tag like `v2` and creates `releases/vN`).
