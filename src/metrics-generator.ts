import { createHash } from 'crypto'
import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'

export interface TMetricsConfig {
  readonly repository: string | undefined
  readonly branch: string | undefined
  readonly commitSha: string | undefined
}

export interface TMetricDataPoint {
  readonly metricName: string
  readonly metricType: 'histogram' | 'counter' | 'updowncounter' | 'gauge'
  readonly value: number
  readonly attributes: Readonly<Record<string, string>>
  readonly description: string
  readonly unit: string | undefined
}

/**
 * Generates a test ID with hash suffix for uniqueness.
 *
 * Format: {start abbreviated}...{end of identifier}_{hash}
 * Example: BF.EX...client.bf.exists_a7f3b2
 *
 * @param suiteName - Test suite name
 * @param className - Test class name
 * @param testName - Test method/case name
 * @returns A unique test identifier
 */
export const generateTestId = (
  suiteName: string,
  className: string,
  testName: string
): string => {
  const START_CHARS = 5
  const END_CHARS = 30
  const HASH_LENGTH = 6

  // Create full identifier for hashing
  const fullIdentifier = `${suiteName}.${className}.${testName}`

  // Generate hash suffix
  const hash = createHash('sha256')
    .update(fullIdentifier)
    .digest('hex')
    .substring(0, HASH_LENGTH)

  // Always show: start...end (end is always END_CHARS from the full identifier)
  const start = fullIdentifier.slice(0, START_CHARS).replace(/\.+$/, '')
  const end = fullIdentifier.slice(-END_CHARS).replace(/^\.+/, '')
  const displayName = `${start}...${end}`

  return `${displayName}___${hash}`
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

  for (const testCase of suite.tests) {
    metrics.push(
      ...generateTestCaseMetrics(testCase, suite.name, baseAttributes)
    )
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
  suiteName: string,
  baseAttributes: Readonly<Record<string, string>>
): readonly TMetricDataPoint[] => {
  const metrics: TMetricDataPoint[] = []

  const testId = generateTestId(suiteName, testCase.classname, testCase.name)

  const testAttributes = {
    ...baseAttributes,
    'test.id': testId
  }

  // Only metric: test duration as a gauge for performance regression detection
  metrics.push({
    metricName: 'test_duration_seconds',
    metricType: 'gauge',
    value: testCase.time,
    attributes: testAttributes,
    description:
      'Individual test execution duration for performance regression detection',
    unit: 's'
  })

  return metrics
}

const getBaseAttributes = (
  config: TMetricsConfig
): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {}

  if (config.repository) {
    attributes['vcs.repository.name'] = config.repository
  }

  if (config.branch) {
    attributes['vcs.repository.ref.name'] = config.branch
  }

  if (config.commitSha) {
    attributes['vcs.repository.ref.revision'] = config.commitSha
  }

  return attributes
}
