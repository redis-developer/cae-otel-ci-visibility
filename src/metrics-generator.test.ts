import {
  generateMetrics,
  generateTestId,
  type TMetricsConfig
} from './metrics-generator.js'
import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'

describe('generateTestId', () => {
  it('generates id with start...end___hash format', () => {
    const testId = generateTestId(
      'BF.ADD',
      'transformArguments',
      'BF.ADD transformArguments'
    )

    // Should have format: start...end___hash
    expect(testId).toMatch(/^.+\.\.\..*___[a-f0-9]{6}$/)
    // Should contain the test name at the end
    expect(testId).toContain('BF.ADD transformArguments')
  })

  it('keeps last 30 characters with ellipsis', () => {
    const testId = generateTestId(
      'TestSuite',
      'with CAPACITY, ERROR, EXPANSION, NOCREATE and NONSCALING',
      'BF.INSERT transformArguments with CAPACITY, ERROR, EXPANSION, NOCREATE and NONSCALING'
    )

    // Should have start...end format
    expect(testId).toMatch(/^.+\.\.\./)
    // Should keep the END of the test name (most distinctive part)
    expect(testId).toContain('NOCREATE and NONSCALING')
    // Should have ___hash suffix
    expect(testId).toMatch(/___[a-f0-9]{6}$/)
  })

  it('generates deterministic ids for same inputs', () => {
    const id1 = generateTestId('Suite', 'Class', 'test')
    const id2 = generateTestId('Suite', 'Class', 'test')

    expect(id1).toBe(id2)
  })

  it('generates different ids for different inputs', () => {
    const id1 = generateTestId('Suite1', 'Class', 'test')
    const id2 = generateTestId('Suite2', 'Class', 'test')

    expect(id1).not.toBe(id2)
  })

  it('always uses start...end format', () => {
    const testId = generateTestId(
      'BF.INSERT',
      'simple',
      'BF.INSERT transformArguments simple'
    )

    // Always has ... in the middle
    expect(testId).toContain('...')
    // Has ___hash at end
    expect(testId).toMatch(/___[a-f0-9]{6}$/)
  })

  it('preserves spaces in test name', () => {
    const testId = generateTestId(
      'BF.ADD',
      'client.bf.add',
      'BF.ADD client.bf.add'
    )

    // Spaces are preserved
    expect(testId).toContain('BF.ADD client.bf.add')
  })
})

describe('generateMetrics', () => {
  const config: TMetricsConfig = {
    repository: 'owner/repo',
    branch: 'main',
    commitSha: 'abc123def456'
  }

  const createTest = (overrides: Partial<TTest> = {}): TTest => ({
    name: 'testMethod',
    classname: 'com.example.TestClass',
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

  it('generates correct metrics structure for simple passed test', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.metricName).toBe('test_duration_seconds')
    expect(metrics[0]!.metricType).toBe('gauge')
  })

  it('generates only 4 labels (test.id + 3 base attributes)', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes
    expect(Object.keys(attributes)).toHaveLength(4)
    expect(attributes).toHaveProperty(['test.id'])
    expect(attributes).toHaveProperty(['vcs.repository.name'])
    expect(attributes).toHaveProperty(['vcs.repository.ref.name'])
    expect(attributes).toHaveProperty(['vcs.repository.ref.revision'])
  })

  it('does not include high-cardinality or removed labels', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes

    // Verify removed labels are not present
    expect(attributes).not.toHaveProperty(['service.name'])
    expect(attributes).not.toHaveProperty(['service.namespace'])
    expect(attributes).not.toHaveProperty(['service.version'])
    expect(attributes).not.toHaveProperty(['deployment.environment'])
    expect(attributes).not.toHaveProperty(['ci.run.id'])
    expect(attributes).not.toHaveProperty(['ci.job.id'])
    expect(attributes).not.toHaveProperty(['test.name'])
    expect(attributes).not.toHaveProperty(['test.class.name'])
    expect(attributes).not.toHaveProperty(['test.suite.name'])
    expect(attributes).not.toHaveProperty(['test.status'])
    expect(attributes).not.toHaveProperty(['test.framework'])
  })

  it('includes test.id with human-readable format', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const testId = metrics[0]!.attributes['test.id']
    expect(testId).toBeDefined()
    // Should contain the test name and have ___hash suffix
    expect(testId).toContain('testMethod')
    expect(testId).toMatch(/___[a-f0-9]{6}$/)
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

  it('generates metrics for multiple tests', () => {
    const tests = [
      createTest({ name: 'test1', time: 1.0 }),
      createTest({ name: 'test2', time: 2.0 }),
      createTest({ name: 'test3', time: 3.0 })
    ]

    const suite = createSuite({
      tests,
      totals: {
        tests: 3,
        passed: 3,
        failed: 0,
        error: 0,
        skipped: 0,
        time: 6.0,
        cumulativeTime: 6.0
      }
    })

    const report = createReport([suite])
    const metrics = generateMetrics(report, config)

    expect(metrics).toHaveLength(3)
    expect(metrics.map((m) => m.value).sort()).toEqual([1.0, 2.0, 3.0])
  })

  it('generates unique test.id for each test', () => {
    const tests = [
      createTest({ name: 'testA' }),
      createTest({ name: 'testB' }),
      createTest({ name: 'testC' })
    ]

    const suite = createSuite({ tests })
    const report = createReport([suite])
    const metrics = generateMetrics(report, config)

    const testIds = metrics.map((m) => m.attributes['test.id'])
    const uniqueIds = new Set(testIds)

    expect(uniqueIds.size).toBe(3)
  })

  it('handles nested suites recursively', () => {
    const nestedTest = createTest({ name: 'nestedTest' })
    const nestedSuite = createSuite({
      name: 'NestedSuite',
      tests: [nestedTest]
    })

    const parentSuite = createSuite({
      name: 'ParentSuite',
      tests: [],
      suites: [nestedSuite]
    })

    const report = createReport([parentSuite])
    const metrics = generateMetrics(report, config)

    expect(metrics).toHaveLength(1)
    // The test.id should contain the test name
    expect(metrics[0]!.attributes['test.id']).toContain('nestedTest')
    expect(metrics[0]!.attributes['test.id']).toMatch(/_[a-f0-9]{6}$/)
  })

  it('handles minimal config with undefined values', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, {
      repository: undefined,
      branch: undefined,
      commitSha: undefined
    })

    expect(metrics.length).toBeGreaterThan(0)
    // Should still have test.id
    expect(metrics[0]!.attributes['test.id']).toBeDefined()
    // Should not have undefined base attributes
    expect(metrics[0]!.attributes['vcs.repository.name']).toBeUndefined()
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

  it('uses v13 low-cardinality attribute schema', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes

    expect(attributes).toMatchInlineSnapshot(`
      {
        "test.id": "TestS...m.example.TestClass.testMethod___c76648",
        "vcs.repository.name": "owner/repo",
        "vcs.repository.ref.name": "main",
        "vcs.repository.ref.revision": "abc123def456",
      }
    `)
  })

  it('generates same test.id for same test across runs', () => {
    const report = createReport([createSuite()])

    const config1: TMetricsConfig = {
      repository: 'owner/repo',
      branch: 'main',
      commitSha: 'commit1'
    }

    const config2: TMetricsConfig = {
      repository: 'owner/repo',
      branch: 'feature',
      commitSha: 'commit2'
    }

    const metrics1 = generateMetrics(report, config1)
    const metrics2 = generateMetrics(report, config2)

    // test.id should be the same regardless of branch/commit
    expect(metrics1[0]!.attributes['test.id']).toBe(
      metrics2[0]!.attributes['test.id']
    )
  })
})
