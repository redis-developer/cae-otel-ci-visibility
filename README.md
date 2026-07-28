# OpenTelemetry CI Visibility Action

Extracts test metrics from JUnit XML files and sends them to OTLP endpoints with
minimal cardinality for efficient storage and querying.

## What it does

- Reads JUnit XML files from a directory
- Parses test results and durations
- Generates low-cardinality OpenTelemetry metrics optimized for performance
  regression detection
- Ships metrics to OTLP-compatible backends (Prometheus, Mimir, Grafana Cloud,
  etc.)

## Usage

```yaml
- uses: redis-developer/cae-otel-ci-visibility@v2
  with:
    junit-xml-folder: './test-results'
    otlp-endpoint: 'https://otlp.example.com/v1/metrics'
    otlp-headers: 'authorization=Bearer ${{ secrets.OTLP_TOKEN }}'
```

## Inputs

| Input              | Required | Default        | Description                                               |
| ------------------ | -------- | -------------- | --------------------------------------------------------- |
| `junit-xml-folder` | yes      | -              | Path to directory containing JUnit XML files              |
| `otlp-endpoint`    | yes      | -              | OTLP metrics endpoint URL                                 |
| `otlp-headers`     | no       | -              | OTLP headers (key=value,key2=value2 or JSON)              |
| `branch-allowlist` | no       | default branch | Branches to emit metrics for (comma-separated, `*` = all) |

### Branch gating

Branch names multiply metric cardinality, and short-lived branches (PRs) never
repeat — so by default metrics are emitted only when the workflow runs on the
repository default branch. Set `branch-allowlist` to a comma-separated list
(e.g. `master,releases/v2`) to emit for those branches instead, or `*` to emit
everywhere (not recommended).

## Metrics

Generates one low-cardinality per-test metric optimized for performance
regression detection, plus three small per-run/per-suite rollups (~5 series +
one per top-level suite per repo) for headline stats and cheap alerting:

### `cae_v15_test_duration_seconds`

A gauge metric recording individual test execution duration. The `cae` namespace
and `v15` schema version are hardcoded.

**Labels:**

| Label                     | Description                          | Cardinality      |
| ------------------------- | ------------------------------------ | ---------------- |
| `test.id`                 | Unique test identifier (see below)   | High but bounded |
| `vcs.repository.name`     | Repository (e.g., `owner/repo`)      | Low              |
| `vcs.repository.ref.name` | Branch name (e.g., `main`, `master`) | Low              |

**Total: 3 labels.** Deliberately **no per-run labels** (run IDs, commit SHAs):
a label value that never repeats mints one new series per test on every CI run,
growing cardinality as `tests × runs`. With stable labels each run appends
samples to existing series and cardinality stays at `tests × repos × branches`.

### Run and suite rollup metrics

Three additive gauges summarize each run without scanning thousands of per-test
series. They carry the same `vcs.repository.name` / `vcs.repository.ref.name`
labels as the per-test metric (no per-run labels), so the series-count impact is
**~5 series + one per top-level suite, per repo/branch**.

#### `cae_v15_test_run_tests`

Number of tests in the run, by result status — one data point per status.

| Label                     | Description                                  | Cardinality |
| ------------------------- | -------------------------------------------- | ----------- |
| `test.result.status`      | `passed` \| `failed` \| `error` \| `skipped` | 4           |
| `vcs.repository.name`     | Repository                                   | Low         |
| `vcs.repository.ref.name` | Branch                                       | Low         |

#### `cae_v15_test_run_duration_seconds`

Cumulative duration of all tests in the run (sum of per-test times). One series
per repo/branch — the cheap target for "is this repo still reporting?" alerts
and per-repo trend panels. Labels: `vcs.repository.name`,
`vcs.repository.ref.name` only.

#### `cae_v15_testsuite_duration_seconds`

Cumulative duration of all tests in each **top-level** test suite (nested suites
roll up into their parent, so they get no point of their own). Catches "every
test in the suite got a little slower" — invisible to the per-test regression
gate.

| Label                     | Description                                                                                              | Cardinality   |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| `suite.id`                | Suite name, whitespace-normalized; over 256 chars truncated to `head...tail___hash8`; `unnamed` if empty | One per suite |
| `vcs.repository.name`     | Repository                                                                                               | Low           |
| `vcs.repository.ref.name` | Branch                                                                                                   | Low           |

### Test ID Format

`test.id` is the full human-readable `{class}.{test}` name:

```
com.redis.lettucemod.RedisModulesClientTest.testTimeSeriesAdd
tests.unit.test_search.TestQueryBuilder.test_paging_offset
BF.ADD transformArguments
```

Rules:

- **Suite names are dropped** — they usually duplicate the class name (Surefire)
  or are constant noise (`pytest`). The suite is used as fallback context when
  the class name is empty, and folded back in only when two different tests
  would otherwise share an ID (same class + test name under different suites).
- **Repeats are collapsed** — a test name that repeats the class as a dot- or
  space-separated prefix appears once (`BF.ADD` + `BF.ADD transformArguments` →
  `BF.ADD transformArguments`).
- **Names over 256 chars** are truncated to `head...tail___hash8`; the hash
  keeps truncated IDs unique (Mimir rejects label values over 2048 bytes).
- **Deterministic** — the same test always generates the same ID.

### Nondeterministic name detection

Run-varying values in test names (UUIDs, timestamps, random ports, temp paths)
mint a new `test_id` series on every run — the same churn removing per-run
labels was meant to stop. The action scans generated IDs for these patterns and
emits a workflow warning listing offenders; fix the test names (or the
reporter's name template) when it fires.

## Dashboard Integration

Example Prometheus/Grafana queries for regression detection:

```promql
# Baseline: average duration on default branch over 7 days
avg by (test_id, vcs_repository_name) (
  avg_over_time(
    cae_v15_test_duration_seconds{
      vcs_repository_ref_name="main"
    }[7d]
  )
)

# Current: latest test duration
max by (test_id, vcs_repository_name) (
  last_over_time(
    cae_v15_test_duration_seconds{
      vcs_repository_ref_name="main"
    }[1h]
  )
)

# Regression detection: current > 5x baseline
max by (test_id, vcs_repository_name) (
  last_over_time(cae_v15_test_duration_seconds{vcs_repository_ref_name="main"}[1h])
)
> 5 * avg by (test_id, vcs_repository_name) (
  avg_over_time(cae_v15_test_duration_seconds{vcs_repository_ref_name="main"}[7d])
)

# Cardinality churn: test ids first seen in the last day. Spikes after merges
# adding tests are normal; a persistently high value means test names are
# nondeterministic (the in-action warning should name the offenders).
count by (vcs_repository_name) (
  last_over_time(cae_v15_test_duration_seconds[1d])
  unless
  last_over_time(cae_v15_test_duration_seconds[7d] offset 1d)
)
```

## Automatic Context

The action automatically extracts from GitHub context:

- Repository name (`owner/repo`)
- Branch name
- Default branch (for branch gating)

The commit SHA is logged in the action output for correlating a regression's
timestamp with the commit that caused it, but is deliberately **not** a metric
label (see cardinality note above).

No manual configuration needed for these values.

## Requirements

- JUnit XML files
- OTLP-compatible metrics backend
- Node.js 24+ runtime (provided by GitHub Actions)

## Migration from v2 (v13 metrics)

v3 (v15) removes the per-run labels that churned one new series per test on
every CI run, and switches `test_id` to the full human-readable name:

| v2 (v13)                            | v3 (v15)                                                       |
| ----------------------------------- | -------------------------------------------------------------- |
| `ci_run_id` label (new UUID / run)  | Removed — per-run values churn series                          |
| `vcs_repository_ref_revision` label | Removed — correlate commits via run timestamps / action logs   |
| `test_id` abbreviated + 6-char hash | Full `class.test` name; truncated + hashed only over 256 chars |
| Emitted on every branch             | Default branch only (`branch-allowlist` input to override)     |
| `cae_v13_*` metric name             | `cae_v15_*` — new series start clean                           |

All `test_id` values change on upgrade, so duration baselines restart from zero.
Update dashboards to query `cae_v15_test_duration_seconds` and drop any
`ci_run_id` / commit-SHA variables and matchers.

(A short-lived `v14` schema shipped only in action v3.0.0: its test IDs kept XML
entities un-decoded and jest-junit duplication, and suites over 2,000 tests hit
the SDK cardinality limit. v3.0.1 fixed those and moved to `v15` so the
malformed day-one series can be discarded wholesale.)

## Migration from v1 (v12 metrics)

v2 uses a simplified, low-cardinality label set. Key changes:

| v1 (v12)                          | v2 (v13)                     |
| --------------------------------- | ---------------------------- |
| `service_name` input required     | Auto-derived from repository |
| `service_namespace` required      | Removed                      |
| `deployment_environment` required | Removed                      |
| `test_name` label                 | Folded into `test_id`        |
| `test_class_name` label           | Folded into `test_id`        |
| `test_suite_name` label           | Folded into `test_id`        |
| `ci_run_id` label                 | Removed                      |
| `ci_job_id` label                 | Removed                      |
| 14+ labels                        | 4 labels                     |

Update your dashboard queries to use `test_id` instead of separate
name/class/suite labels.

## Notes

- Processes all `.xml` files in the specified directory
- Combines multiple XML files into a single report
- Handles malformed XML gracefully
- The OTel SDK cardinality limit is raised to 20,000 attribute sets (the SDK
  default of 2,000 silently merges suites larger than 2k tests into a single
  `otel.metric.overflow` data point); the action warns if a report ever exceeds
  it
- No outputs - metrics are the deliverable

Built for engineers who want observability without ceremony.
