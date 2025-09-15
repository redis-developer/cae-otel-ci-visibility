# OpenTelemetry CI Visibility Action

Extracts test metrics from JUnit XML files and ships them to OTLP endpoints.

## What it does

- Reads JUnit XML files from a directory
- Parses test results (passed/failed/skipped/errors)
- Generates OpenTelemetry metrics with proper semantic conventions
- Ships metrics to OTLP-compatible backends

## Usage

```yaml
- uses: redis-developer/cae-otel-ci-visibility@v1
  with:
    junit-xml-folder: './test-results'
    service-name: 'my-service'
    service-namespace: 'my-team'
    service-version: 'v1.2.3'
    deployment-environment: 'ci'
    otlp-endpoint: 'https://otlp.example.com/v1/metrics'
    otlp-headers: 'authorization=Bearer ${{ secrets.OTLP_TOKEN }}'
```

## Inputs

| Input                    | Required | Default   | Description                                  |
| ------------------------ | -------- | --------- | -------------------------------------------- |
| `junit-xml-folder`       | yes      | -         | Path to directory containing JUnit XML files |
| `service-name`           | yes      | -         | OpenTelemetry service name                   |
| `service-namespace`      | yes      | -         | OpenTelemetry service namespace              |
| `deployment-environment` | yes      | `staging` | Deployment environment                       |
| `otlp-endpoint`          | yes      | -         | OTLP metrics endpoint URL                    |
| `service-version`        | no       | git SHA   | Service version                              |
| `otlp-headers`           | no       | -         | OTLP headers (key=value,key2=value2 or JSON) |

## Metrics

Generates standard test metrics:

- `test.duration` - Individual test execution time
- `test.status` - Test execution count by status
- `test.suite.duration` - Test suite execution time
- `test.suite.total` - Test count per suite by status
- `test.failure` - Test failures by type
- `test.error` - Test errors by type

All metrics include proper OpenTelemetry semantic conventions and CI context.

## Requirements

- JUnit XML files
- OTLP-compatible metrics backend
- Node.js 24+ runtime

## Notes

- Processes all `.xml` files in the specified directory
- Combines multiple XML files into a single report
- Handles malformed XML gracefully
- No outputs - metrics are the deliverable

Built for engineers who want observability without ceremony.
