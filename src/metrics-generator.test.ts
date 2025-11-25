import { generateMetrics, type TMetricsConfig } from './metrics-generator.js'
import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'
import { setTimeout } from 'timers/promises'
describe('generateMetrics', () => {
  const config: TMetricsConfig = {
    serviceName: 'test-service',
    serviceVersion: '1.0.0',
    environment: 'test',
    repository: 'test/repo',
    branch: 'main',
    commitSha: 'abc123',
    runId: 'build-456',
    jobUUID: 'job-456'
  }

  const createTest = (overrides: Partial<TTest> = {}): TTest => ({
    name: 'test1',
    classname: 'com.example.Test',
    time: 1.5,
    result: { status: 'passed' },
    properties: undefined,
    systemOut: undefined,
    systemErr: undefined,
    ...overrides
  })

  const createSuite = (overrides: Partial<TSuite> = {}): TSuite => ({
    name: 'TestSuite',
    properties: undefined,
    tests: [createTest()],
    suites: undefined,
    systemOut: undefined,
    systemErr: undefined,
    totals: {
      tests: 1,
      passed: 1,
      failed: 0,
      error: 0,
      skipped: 0,
      time: 1.5,
      cumulativeTime: 1.5
    },
    ...overrides
  })

  const createReport = (suites: TSuite[]): TJUnitReport => ({
    testsuites: suites,
    totals: suites.reduce(
      (acc, suite) => ({
        tests: acc.tests + suite.totals.tests,
        passed: acc.passed + suite.totals.passed,
        failed: acc.failed + suite.totals.failed,
        error: acc.error + suite.totals.error,
        skipped: acc.skipped + suite.totals.skipped,
        time: acc.time + suite.totals.time,
        cumulativeTime: acc.cumulativeTime + suite.totals.cumulativeTime
      }),
      {
        tests: 0,
        passed: 0,
        failed: 0,
        error: 0,
        skipped: 0,
        time: 0,
        cumulativeTime: 0
      }
    )
  })

  it('generates correct metrics structure for simple passed test', async () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)
    await setTimeout(4000, () => {})
    expect(metrics).toHaveLength(1)

    expect(metrics.map((m) => ({ name: m.metricName, type: m.metricType })))
      .toMatchInlineSnapshot(`
      [
        {
          "name": "test_duration_seconds",
          "type": "gauge",
        },
      ]
    `)

    const firstMetric = metrics[0]!
    expect(firstMetric.attributes['service.name']).toBe('test-service')

    metrics.forEach((metric) => {
      expect(metric.attributes['service.name']).toBe('test-service')
      expect(metric.unit).toBeDefined()
      expect(metric.description).toBeDefined()
    })

    const suiteMetrics = metrics.filter((m) =>
      m.metricName.startsWith('test.suite')
    )
    suiteMetrics.forEach((metric) => {
      expect(metric.attributes['test.framework']).toBe('junit')
    })
  })

  it('generates gauge metrics for test duration', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const testDuration = metrics.find(
      (m) => m.metricName === 'test_duration_seconds'
    )

    expect(testDuration).toBeDefined()
    expect(testDuration?.metricType).toBe('gauge')
    expect(testDuration?.value).toBe(1.5)
    expect(testDuration?.unit).toBe('s')
  })

  it('generates metrics for all test statuses', () => {
    const tests = [
      createTest({ name: 'test1', result: { status: 'passed' } }),
      createTest({
        name: 'test2',
        result: {
          status: 'failed',
          message: undefined,
          type: 'AssertionError',
          body: undefined
        }
      }),
      createTest({
        name: 'test3',
        result: {
          status: 'error',
          message: undefined,
          type: 'RuntimeError',
          body: undefined
        }
      }),
      createTest({
        name: 'test4',
        result: { status: 'skipped', message: undefined }
      })
    ]

    const suite = createSuite({
      tests,
      totals: {
        tests: 4,
        passed: 1,
        failed: 1,
        error: 1,
        skipped: 1,
        time: 6.0,
        cumulativeTime: 6.0
      }
    })

    const report = createReport([suite])
    const metrics = generateMetrics(report, config)

    expect(metrics).toHaveLength(4)
    expect(metrics.map((m) => m.attributes['test.status']).sort()).toEqual([
      'error',
      'failed',
      'passed',
      'skipped'
    ])

    expect(metrics.every((m) => m.metricName === 'test_duration_seconds')).toBe(
      true
    )
    expect(metrics.every((m) => m.metricType === 'gauge')).toBe(true)
  })

  it('handles nested suites recursively', () => {
    const nestedSuite = createSuite({ name: 'NestedSuite' })
    const parentSuite = createSuite({
      name: 'ParentSuite',
      tests: [],
      suites: [nestedSuite],
      totals: {
        tests: 1,
        passed: 1,
        failed: 0,
        error: 0,
        skipped: 0,
        time: 2.0,
        cumulativeTime: 2.0
      }
    })

    const report = createReport([parentSuite])
    const metrics = generateMetrics(report, config)

    expect(metrics).toHaveLength(1)

    expect(metrics[0]!.attributes['test.suite.name']).toBe('NestedSuite')
  })

  it('uses OpenTelemetry semantic conventions for attribute names', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const baseAttributes = metrics[0]!.attributes
    expect(baseAttributes).toMatchInlineSnapshot(
      {
        'service.name': expect.any(String),
        'service.version': expect.any(String),
        'deployment.environment': expect.any(String),
        'vcs.repository.name': expect.any(String),
        'vcs.repository.ref.name': expect.any(String),
        'vcs.repository.ref.revision': expect.any(String),
        'ci.run.id': expect.any(String)
      },
      `
      {
        "ci.job.id": "job-456",
        "ci.run.id": Any<String>,
        "deployment.environment": Any<String>,
        "service.name": Any<String>,
        "service.version": Any<String>,
        "test.class.name": "com.example.Test",
        "test.framework": "junit",
        "test.name": "test1",
        "test.status": "passed",
        "test.suite.name": "TestSuite",
        "vcs.repository.name": Any<String>,
        "vcs.repository.ref.name": Any<String>,
        "vcs.repository.ref.revision": Any<String>,
      }
    `
    )
  })

  it('handles minimal config with only required fields', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, {
      serviceName: 'minimal',
      serviceVersion: undefined,
      environment: undefined,
      repository: undefined,
      branch: undefined,
      commitSha: undefined,
      runId: undefined,
      jobUUID: undefined
    })

    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics[0]!.attributes['service.name']).toBe('minimal')
  })

  it('preserves duration values in seconds', () => {
    const testWithDuration = createTest({ time: 2.5 })
    const suiteWithDuration = createSuite({
      tests: [testWithDuration],
      totals: {
        tests: 1,
        passed: 1,
        failed: 0,
        error: 0,
        skipped: 0,
        time: 2.5,
        cumulativeTime: 2.5
      }
    })

    const report = createReport([suiteWithDuration])
    const metrics = generateMetrics(report, config)

    const testDuration = metrics.find(
      (m) => m.metricName === 'test_duration_seconds'
    )

    expect(testDuration?.value).toBe(2.5)
    expect(testDuration?.unit).toBe('s')
    expect(testDuration?.metricType).toBe('gauge')
  })
})
