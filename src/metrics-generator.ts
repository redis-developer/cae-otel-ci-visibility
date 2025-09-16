import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'

export interface TMetricsConfig {
  readonly serviceName: string
  readonly serviceNamespace?: string
  readonly serviceVersion: string | undefined
  readonly environment: string | undefined
  readonly repository: string | undefined
  readonly branch: string | undefined
  readonly commitSha: string | undefined
  readonly runId: string | undefined
  readonly jobUUID: string | undefined
}

export interface TMetricDataPoint {
  readonly metricName: string
  readonly metricType: 'histogram' | 'counter' | 'updowncounter'
  readonly value: number
  readonly attributes: Readonly<Record<string, string>>
  readonly description: string
  readonly unit: string | undefined
}

export const generateMetrics = (
  report: TJUnitReport,
  config: TMetricsConfig
): readonly TMetricDataPoint[] => {
  const metrics: TMetricDataPoint[] = []
  const baseAttributes = getBaseAttributes(config)

  for (const suite of report.testsuites) {
    metrics.push(...generateSuiteMetrics(suite, baseAttributes))
  }

  return metrics
}

const generateSuiteMetrics = (
  suite: TSuite,
  baseAttributes: Readonly<Record<string, string>>
): readonly TMetricDataPoint[] => {
  const metrics: TMetricDataPoint[] = []

  const suiteAttributes = {
    ...baseAttributes,
    'test.suite.name': suite.name,
    'test.framework': 'junit'
  }

  metrics.push({
    metricName: 'test.suite.duration',
    metricType: 'histogram',
    value: suite.totals.time,
    attributes: suiteAttributes,
    description: 'Test suite execution time (from XML time attribute)',
    unit: 's'
  })

  metrics.push({
    metricName: 'test.suite.cumulative_duration',
    metricType: 'histogram',
    value: suite.totals.cumulativeTime,
    attributes: suiteAttributes,
    description: 'Test suite cumulative time (calculated from child elements)',
    unit: 's'
  })

  const statusCounts = [
    { status: 'passed', count: suite.totals.passed },
    { status: 'failed', count: suite.totals.failed },
    { status: 'error', count: suite.totals.error },
    { status: 'skipped', count: suite.totals.skipped }
  ] as const

  for (const { status, count } of statusCounts) {
    if (count > 0) {
      metrics.push({
        metricName: 'test.suite.total',
        metricType: 'updowncounter',
        value: count,
        attributes: {
          ...suiteAttributes,
          'test.status': status
        },
        description: 'Current test count per suite by status',
        unit: '{test}'
      })
    }
  }

  for (const testCase of suite.tests) {
    metrics.push(...generateTestCaseMetrics(testCase, suiteAttributes))
  }

  if (suite.suites) {
    for (const nestedSuite of suite.suites) {
      metrics.push(...generateSuiteMetrics(nestedSuite, baseAttributes))
    }
  }

  return metrics
}

const generateTestCaseMetrics = (
  testCase: TTest,
  suiteAttributes: Readonly<Record<string, string>>
): readonly TMetricDataPoint[] => {
  const metrics: TMetricDataPoint[] = []

  const testAttributes = {
    ...suiteAttributes,
    'test.name': testCase.name,
    'test.class.name': testCase.classname,
    'test.status': testCase.result.status
  }

  metrics.push({
    metricName: 'test.duration',
    metricType: 'histogram',
    value: testCase.time,
    attributes: testAttributes,
    description: 'Individual test execution time',
    unit: 's'
  })

  metrics.push({
    metricName: 'test.status',
    metricType: 'counter',
    value: 1,
    attributes: testAttributes,
    description: 'Test execution count by status',
    unit: '{test}'
  })

  switch (testCase.result.status) {
    case 'failed':
      if (testCase.result.type) {
        metrics.push({
          metricName: 'test.failure',
          metricType: 'counter',
          value: 1,
          attributes: {
            ...testAttributes,
            'failure.type': testCase.result.type
          },
          description: 'Test failures by type',
          unit: '{failure}'
        })
      }
      break

    case 'error':
      if (testCase.result.type) {
        metrics.push({
          metricName: 'test.error',
          metricType: 'counter',
          value: 1,
          attributes: {
            ...testAttributes,
            'error.type': testCase.result.type
          },
          description: 'Test errors by type',
          unit: '{error}'
        })
      }
      break
  }

  return metrics
}

const getBaseAttributes = (
  config: TMetricsConfig
): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {
    'service.name': config.serviceName
  }

  if (config.serviceNamespace)
    attributes['service.namespace'] = config.serviceNamespace
  if (config.serviceVersion)
    attributes['service.version'] = config.serviceVersion
  if (config.environment)
    attributes['deployment.environment'] = config.environment
  if (config.repository) attributes['vcs.repository.name'] = config.repository
  if (config.branch) attributes['vcs.repository.ref.name'] = config.branch
  if (config.commitSha)
    attributes['vcs.repository.ref.revision'] = config.commitSha
  if (config.runId) {
    attributes['ci.run.id'] = config.runId
  }

  if (config.jobUUID) {
    attributes['ci.job.id'] = config.jobUUID
  }

  return attributes
}
