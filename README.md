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

| Input               | Required | Default | Description                                  |
| ------------------- | -------- | ------- | -------------------------------------------- |
| `junit-xml-folder`  | yes      | -       | Path to directory containing JUnit XML files |
| `otlp-endpoint`     | yes      | -       | OTLP metrics endpoint URL                    |
| `otlp-headers`      | no       | -       | OTLP headers (key=value,key2=value2 or JSON) |
| `metrics-namespace` | no       | `cae`   | Namespace prefix for metrics                 |
| `metrics-version`   | no       | `v13`   | Version identifier for metrics schema        |

## Metrics

Generates a single, low-cardinality metric optimized for performance regression
detection:

### `{namespace}_{version}_test_duration_seconds`

A gauge metric recording individual test execution duration.

**Labels:**

| Label                         | Description                          | Cardinality |
| ----------------------------- | ------------------------------------ | ----------- |
| `test.id`                     | Unique test identifier (see below)   | Medium      |
| `vcs.repository.name`         | Repository (e.g., `owner/repo`)      | Low         |
| `vcs.repository.ref.name`     | Branch name (e.g., `main`, `master`) | Low         |
| `vcs.repository.ref.revision` | Commit SHA                           | High        |

**Total: 4 labels** - optimized to avoid Mimir/Prometheus query size limits.

### Test ID Format

The `test.id` label combines suite, class, and test name into a human-readable
identifier with a hash suffix for uniqueness:

```
Format: {ClassName}.{testMethodName}_{hash}

Examples:
- UserServiceTest.testLogin_a7f3b2
- PaymentProcessor.testRefun_c4d8e1
```

This provides:

- **Human readability** - Identify the test at a glance in dashboards
- **Uniqueness** - 6-char hash suffix handles collisions
- **Determinism** - Same test always generates the same ID

## Dashboard Integration

Example Prometheus/Grafana queries for regression detection:

```promql
# Baseline: average duration on default branch over 7 days
avg by (test_id, vcs_repository_name) (
  avg_over_time(
    cae_v13_test_duration_seconds{
      vcs_repository_ref_name="main"
    }[7d]
  )
)

# Current: latest test duration
max by (test_id, vcs_repository_name) (
  last_over_time(
    cae_v13_test_duration_seconds{
      vcs_repository_ref_name="main"
    }[1h]
  )
)

# Regression detection: current > 5x baseline
max by (test_id, vcs_repository_name) (
  last_over_time(cae_v13_test_duration_seconds{vcs_repository_ref_name="main"}[1h])
)
> 5 * avg by (test_id, vcs_repository_name) (
  avg_over_time(cae_v13_test_duration_seconds{vcs_repository_ref_name="main"}[7d])
)
```

## Automatic Context

The action automatically extracts from GitHub context:

- Repository name (`owner/repo`)
- Branch name
- Commit SHA

No manual configuration needed for these values.

## Requirements

- JUnit XML files
- OTLP-compatible metrics backend
- Node.js 24+ runtime (provided by GitHub Actions)

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
- No outputs - metrics are the deliverable

Built for engineers who want observability without ceremony.
