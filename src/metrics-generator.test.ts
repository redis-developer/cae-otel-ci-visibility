import {
  generateMetrics,
  generateTestId,
  type TMetricsConfig
} from './metrics-generator.js'
import type { TJUnitReport, TSuite, TTest } from './junit-parser.js'

describe('generateTestId', () => {
  const cases: {
    name: string
    suite: string
    className: string
    test: string
    expected: string
  }[] = [
    {
      name: 'id is class.test — suite name is ignored',
      suite: 'a',
      className: 'b',
      test: 'testName',
      expected: 'b.testName'
    },
    {
      name: 'compacts test names that extend the class across a dot',
      suite: 'a.b',
      className: 'a.b.d',
      test: 'a.b.d.testName',
      expected: 'a.b.d.testName'
    },
    {
      name: 'surefire style: suite repeating the class adds nothing',
      suite: 'com.example.TestClass',
      className: 'com.example.TestClass',
      test: 'testMethod',
      expected: 'com.example.TestClass.testMethod'
    },
    {
      name: 'a distinct suite name is still ignored when class exists',
      suite: 'IgnoredSuite',
      className: 'com.example.TestClass',
      test: 'testMethod',
      expected: 'com.example.TestClass.testMethod'
    },
    {
      name: 'pytest style: the constant "pytest" suite is dropped',
      suite: 'pytest',
      className: 'tests.unit.test_parser.TestParser',
      test: 'test_parses_nested_suites',
      expected: 'tests.unit.test_parser.TestParser.test_parses_nested_suites'
    },
    {
      name: 'jest default: test repeating the class as space-prefix collapses',
      suite: 'BF.ADD',
      className: 'BF.ADD',
      test: 'BF.ADD transformArguments',
      expected: 'BF.ADD transformArguments'
    },
    {
      name: 'jest with path classname: no repeats, spaces preserved',
      suite: 'BF.ADD',
      className: 'client.bf.add',
      test: 'BF.ADD transformArguments',
      expected: 'client.bf.add.BF.ADD transformArguments'
    },
    {
      name: 'test name equal to the class name appears once',
      suite: 'Suite',
      className: 'shouldDoTheThing',
      test: 'shouldDoTheThing',
      expected: 'shouldDoTheThing'
    },
    {
      name: 'class already ending with the test name appears once',
      suite: 'Suite',
      className: 'BF.ADD transformArguments',
      test: 'transformArguments',
      expected: 'BF.ADD transformArguments'
    },
    {
      name: 'jest default classname: test ending with the class collapses',
      suite: 'Generic Transformers',
      className: '0, 1',
      test: 'Generic Transformers transformBooleanArrayReply 0, 1',
      expected: 'Generic Transformers transformBooleanArrayReply 0, 1'
    },
    {
      name: 'test ending with the class across a dot collapses',
      suite: '',
      className: 'client.latencyHistory',
      test: 'LATENCY HISTORY client.latencyHistory',
      expected: 'LATENCY HISTORY client.latencyHistory'
    },
    {
      name: 'suite is used as fallback context when class is empty',
      suite: 'IntegrationSuite',
      className: '',
      test: 'connects',
      expected: 'IntegrationSuite.connects'
    },
    {
      name: 'test name alone when suite and class are empty',
      suite: '',
      className: '',
      test: 'testOnly',
      expected: 'testOnly'
    },
    {
      name: 'class alone when the test name is empty',
      suite: '',
      className: 'com.example.TestClass',
      test: '',
      expected: 'com.example.TestClass'
    },
    {
      name: 'whitespace runs are collapsed and segments trimmed',
      suite: '  Suite  ',
      className: 'Class',
      test: 'test   name\nwith newline',
      expected: 'Class.test name with newline'
    },
    {
      name: 'shared prefix without a separator boundary is not compacted',
      suite: '',
      className: 'com.example.TestClass',
      test: 'com.example.TestClassOther',
      expected: 'com.example.TestClass.com.example.TestClassOther'
    },
    {
      name: 'all segments empty falls back to unnamed',
      suite: '',
      className: '   ',
      test: '',
      expected: 'unnamed'
    }
  ]

  it.each(cases)('$name', ({ suite, className, test, expected }) => {
    expect(generateTestId(suite, className, test)).toBe(expected)
  })

  it('generates deterministic ids for same inputs', () => {
    const id1 = generateTestId('Suite', 'Class', 'test')
    const id2 = generateTestId('Suite', 'Class', 'test')

    expect(id1).toBe(id2)
  })

  it('generates different ids for different inputs', () => {
    const id1 = generateTestId('Suite', 'Class1', 'test')
    const id2 = generateTestId('Suite', 'Class2', 'test')

    expect(id1).not.toBe(id2)
  })

  describe('long names', () => {
    it('returns names of exactly 256 characters verbatim, without hash', () => {
      const testName = 'x'.repeat(254)
      const id = generateTestId('S', 'C', testName)

      expect(id).toBe(`C.${testName}`)
      expect(id).toHaveLength(256)
    })

    it('truncates names over 256 characters to head...tail___hash', () => {
      const id = generateTestId(
        'com.example.integration',
        'com.example.integration.VeryLongParameterizedSuite',
        `handles bulk import [${'x'.repeat(300)}] with retries enabled`
      )

      expect(id.length).toBeLessThanOrEqual(256)
      expect(id).toMatch(/^.+\.\.\..+___[a-f0-9]{8}$/)
      // The distinctive tail of the name survives truncation
      expect(id).toContain('with retries enabled')
    })

    it('keeps truncated ids distinct when names differ only in the middle', () => {
      const head = 'h'.repeat(150)
      const tail = 't'.repeat(200)

      const id1 = generateTestId('S', 'C', `${head}AAA${tail}`)
      const id2 = generateTestId('S', 'C', `${head}BBB${tail}`)

      expect(id1).not.toBe(id2)
    })

    it('truncated ids are deterministic', () => {
      const longName = `test ${'y'.repeat(300)}`

      expect(generateTestId('S', 'C', longName)).toBe(
        generateTestId('S', 'C', longName)
      )
    })
  })
})

describe('generateMetrics', () => {
  const config: TMetricsConfig = {
    repository: 'owner/repo',
    branch: 'main'
  }

  const byName = (
    metrics: ReturnType<typeof generateMetrics>,
    metricName: string
  ) => metrics.filter((m) => m.metricName === metricName)

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

    const testDurations = byName(metrics, 'test_duration_seconds')
    expect(testDurations).toHaveLength(1)
    expect(testDurations[0]!.metricType).toBe('gauge')

    // per-test points come first, then the additive per-run/per-suite rollups
    expect(metrics[0]!.metricName).toBe('test_duration_seconds')
    expect(metrics.map((m) => m.metricName)).toEqual([
      'test_duration_seconds',
      'test_run_tests',
      'test_run_tests',
      'test_run_tests',
      'test_run_tests',
      'test_run_duration_seconds',
      'testsuite_duration_seconds'
    ])
  })

  it('generates only 3 labels (test.id + repository + branch)', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes
    expect(Object.keys(attributes)).toHaveLength(3)
    expect(attributes).toHaveProperty(['test.id'])
    expect(attributes).toHaveProperty(['vcs.repository.name'])
    expect(attributes).toHaveProperty(['vcs.repository.ref.name'])
  })

  it('does not include per-run or removed labels', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes

    // Per-run values churn one new series per test per run
    expect(attributes).not.toHaveProperty(['ci.run.id'])
    expect(attributes).not.toHaveProperty(['vcs.repository.ref.revision'])

    // Verify removed labels are not present
    expect(attributes).not.toHaveProperty(['service.name'])
    expect(attributes).not.toHaveProperty(['service.namespace'])
    expect(attributes).not.toHaveProperty(['service.version'])
    expect(attributes).not.toHaveProperty(['deployment.environment'])
    expect(attributes).not.toHaveProperty(['ci.job.id'])
    expect(attributes).not.toHaveProperty(['test.name'])
    expect(attributes).not.toHaveProperty(['test.class.name'])
    expect(attributes).not.toHaveProperty(['test.suite.name'])
    expect(attributes).not.toHaveProperty(['test.status'])
    expect(attributes).not.toHaveProperty(['test.framework'])
  })

  it('includes test.id as the full human-readable dotted name', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const testId = metrics[0]!.attributes['test.id']
    expect(testId).toBe('com.example.TestClass.testMethod')
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
    const metrics = byName(
      generateMetrics(report, config),
      'test_duration_seconds'
    )

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
    const metrics = byName(
      generateMetrics(report, config),
      'test_duration_seconds'
    )

    const testIds = metrics.map((m) => m.attributes['test.id'])
    const uniqueIds = new Set(testIds)

    expect(uniqueIds.size).toBe(3)
  })

  it('disambiguates same class+test under different suites with the suite name', () => {
    const suiteA = createSuite({
      name: 'BF.ADD',
      tests: [
        createTest({ classname: 'client.bf', name: 'transformArguments' }),
        createTest({ classname: 'client.bf', name: 'reserve' })
      ]
    })
    const suiteB = createSuite({
      name: 'BF.EXISTS',
      tests: [
        createTest({ classname: 'client.bf', name: 'transformArguments' })
      ]
    })

    const metrics = byName(
      generateMetrics(createReport([suiteA, suiteB]), config),
      'test_duration_seconds'
    )

    expect(metrics.map((m) => m.attributes['test.id'])).toEqual([
      // colliding pair gets the suite-qualified form
      'BF.ADD.client.bf.transformArguments',
      // non-colliding neighbour keeps the short form
      'client.bf.reserve',
      'BF.EXISTS.client.bf.transformArguments'
    ])
  })

  it('reruns of the identical test are not collisions and share one id', () => {
    const suite = createSuite({
      name: 'BF.ADD',
      tests: [
        createTest({
          classname: 'client.bf',
          name: 'transformArguments',
          time: 1.0
        }),
        createTest({
          classname: 'client.bf',
          name: 'transformArguments',
          time: 2.0
        })
      ]
    })

    const metrics = byName(
      generateMetrics(createReport([suite]), config),
      'test_duration_seconds'
    )

    expect(metrics).toHaveLength(2)
    expect(metrics.map((m) => m.attributes['test.id'])).toEqual([
      'client.bf.transformArguments',
      'client.bf.transformArguments'
    ])
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
    const metrics = byName(
      generateMetrics(report, config),
      'test_duration_seconds'
    )

    expect(metrics).toHaveLength(1)
    expect(metrics[0]!.attributes['test.id']).toBe(
      'com.example.TestClass.nestedTest'
    )
  })

  it('handles minimal config with undefined values', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, {
      repository: undefined,
      branch: undefined
    })

    expect(metrics.length).toBeGreaterThan(0)
    // test.id is the only attribute left when repo/branch are unknown
    expect(metrics[0]!.attributes['test.id']).toBeDefined()
    expect(Object.keys(metrics[0]!.attributes)).toHaveLength(1)
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

  it('uses v15 low-cardinality attribute schema', () => {
    const report = createReport([createSuite()])
    const metrics = generateMetrics(report, config)

    const attributes = metrics[0]!.attributes

    expect(attributes).toMatchInlineSnapshot(`
      {
        "test.id": "com.example.TestClass.testMethod",
        "vcs.repository.name": "owner/repo",
        "vcs.repository.ref.name": "main",
      }
    `)
  })

  it('generates same test.id for same test regardless of branch', () => {
    const report = createReport([createSuite()])

    const config1: TMetricsConfig = {
      repository: 'owner/repo',
      branch: 'main'
    }

    const config2: TMetricsConfig = {
      repository: 'owner/repo',
      branch: 'feature'
    }

    const metrics1 = generateMetrics(report, config1)
    const metrics2 = generateMetrics(report, config2)

    expect(metrics1[0]!.attributes['test.id']).toBe(
      metrics2[0]!.attributes['test.id']
    )
  })

  describe('per-run summary rollups', () => {
    const mixedSuite = (): TSuite =>
      createSuite({
        name: 'MixedSuite',
        tests: [
          createTest({ name: 'ok1', time: 1.0 }),
          createTest({ name: 'ok2', time: 2.0 }),
          createTest({
            name: 'bad',
            time: 0.5,
            result: {
              status: 'failed',
              message: undefined,
              type: undefined,
              body: undefined
            }
          }),
          createTest({
            name: 'boom',
            time: 0.25,
            result: {
              status: 'error',
              message: undefined,
              type: undefined,
              body: undefined
            }
          }),
          createTest({
            name: 'meh',
            time: 0,
            result: { status: 'skipped', message: undefined }
          })
        ],
        totals: {
          tests: 5,
          passed: 2,
          failed: 1,
          error: 1,
          skipped: 1,
          time: 3.75,
          cumulativeTime: 3.75
        }
      })

    it('emits one test_run_tests gauge point per result status from report.totals', () => {
      const metrics = generateMetrics(createReport([mixedSuite()]), config)
      const runTests = byName(metrics, 'test_run_tests')

      expect(runTests).toHaveLength(4)
      expect(runTests.every((m) => m.metricType === 'gauge')).toBe(true)

      const countsByStatus = Object.fromEntries(
        runTests.map((m) => [m.attributes['test.result.status'], m.value])
      )
      expect(countsByStatus).toEqual({
        passed: 2,
        failed: 1,
        error: 1,
        skipped: 1
      })

      for (const point of runTests) {
        expect(Object.keys(point.attributes).sort()).toEqual([
          'test.result.status',
          'vcs.repository.name',
          'vcs.repository.ref.name'
        ])
        expect(point.attributes['vcs.repository.name']).toBe('owner/repo')
        expect(point.attributes['vcs.repository.ref.name']).toBe('main')
      }
    })

    it('emits a single test_run_duration_seconds point from totals.cumulativeTime', () => {
      const metrics = generateMetrics(createReport([mixedSuite()]), config)
      const runDuration = byName(metrics, 'test_run_duration_seconds')

      expect(runDuration).toHaveLength(1)
      expect(runDuration[0]!.metricType).toBe('gauge')
      expect(runDuration[0]!.value).toBe(3.75)
      expect(runDuration[0]!.unit).toBe('s')
      expect(runDuration[0]!.attributes).toEqual({
        'vcs.repository.name': 'owner/repo',
        'vcs.repository.ref.name': 'main'
      })
    })

    it('run summary points match the snapshot', () => {
      const metrics = generateMetrics(createReport([mixedSuite()]), config)

      expect(metrics.filter((m) => m.metricName.startsWith('test_run_')))
        .toMatchInlineSnapshot(`
        [
          {
            "attributes": {
              "test.result.status": "passed",
              "vcs.repository.name": "owner/repo",
              "vcs.repository.ref.name": "main",
            },
            "description": "Number of tests in the run, by result status",
            "metricName": "test_run_tests",
            "metricType": "gauge",
            "unit": "{test}",
            "value": 2,
          },
          {
            "attributes": {
              "test.result.status": "failed",
              "vcs.repository.name": "owner/repo",
              "vcs.repository.ref.name": "main",
            },
            "description": "Number of tests in the run, by result status",
            "metricName": "test_run_tests",
            "metricType": "gauge",
            "unit": "{test}",
            "value": 1,
          },
          {
            "attributes": {
              "test.result.status": "error",
              "vcs.repository.name": "owner/repo",
              "vcs.repository.ref.name": "main",
            },
            "description": "Number of tests in the run, by result status",
            "metricName": "test_run_tests",
            "metricType": "gauge",
            "unit": "{test}",
            "value": 1,
          },
          {
            "attributes": {
              "test.result.status": "skipped",
              "vcs.repository.name": "owner/repo",
              "vcs.repository.ref.name": "main",
            },
            "description": "Number of tests in the run, by result status",
            "metricName": "test_run_tests",
            "metricType": "gauge",
            "unit": "{test}",
            "value": 1,
          },
          {
            "attributes": {
              "vcs.repository.name": "owner/repo",
              "vcs.repository.ref.name": "main",
            },
            "description": "Cumulative duration of all tests in the run",
            "metricName": "test_run_duration_seconds",
            "metricType": "gauge",
            "unit": "s",
            "value": 3.75,
          },
        ]
      `)
    })

    it('omits repo/branch attributes when unknown, keeping test.result.status', () => {
      const metrics = generateMetrics(createReport([mixedSuite()]), {
        repository: undefined,
        branch: undefined
      })

      const runTests = byName(metrics, 'test_run_tests')
      expect(Object.keys(runTests[0]!.attributes)).toEqual([
        'test.result.status'
      ])

      const runDuration = byName(metrics, 'test_run_duration_seconds')
      expect(runDuration[0]!.attributes).toEqual({})
    })
  })

  describe('per-suite rollups', () => {
    it('emits one testsuite_duration_seconds point per top-level suite', () => {
      const suiteA = createSuite({
        name: 'SuiteA',
        totals: {
          tests: 1,
          passed: 1,
          failed: 0,
          error: 0,
          skipped: 0,
          time: 1.5,
          cumulativeTime: 1.5
        }
      })
      const suiteB = createSuite({
        name: 'SuiteB',
        tests: [createTest({ name: 'other', time: 4.0 })],
        totals: {
          tests: 1,
          passed: 1,
          failed: 0,
          error: 0,
          skipped: 0,
          time: 4.0,
          cumulativeTime: 4.0
        }
      })

      const metrics = generateMetrics(createReport([suiteA, suiteB]), config)
      const suiteDurations = byName(metrics, 'testsuite_duration_seconds')

      expect(suiteDurations).toHaveLength(2)
      expect(
        suiteDurations.map((m) => [m.attributes['suite.id'], m.value])
      ).toEqual([
        ['SuiteA', 1.5],
        ['SuiteB', 4.0]
      ])

      for (const point of suiteDurations) {
        expect(point.metricType).toBe('gauge')
        expect(point.unit).toBe('s')
        expect(point.attributes['vcs.repository.name']).toBe('owner/repo')
        expect(point.attributes['vcs.repository.ref.name']).toBe('main')
      }
    })

    it('does not emit points for nested suites (parent already includes them)', () => {
      const nestedSuite = createSuite({
        name: 'NestedSuite',
        totals: {
          tests: 1,
          passed: 1,
          failed: 0,
          error: 0,
          skipped: 0,
          time: 1.5,
          cumulativeTime: 1.5
        }
      })
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
          time: 1.5,
          cumulativeTime: 1.5
        }
      })

      const metrics = generateMetrics(createReport([parentSuite]), config)
      const suiteDurations = byName(metrics, 'testsuite_duration_seconds')

      expect(suiteDurations).toHaveLength(1)
      expect(suiteDurations[0]!.attributes['suite.id']).toBe('ParentSuite')
      expect(suiteDurations[0]!.value).toBe(1.5)
    })

    it('normalizes whitespace in suite.id', () => {
      const suite = createSuite({ name: '  Suite   with\nspaces  ' })

      const metrics = generateMetrics(createReport([suite]), config)
      const suiteDurations = byName(metrics, 'testsuite_duration_seconds')

      expect(suiteDurations[0]!.attributes['suite.id']).toBe(
        'Suite with spaces'
      )
    })

    it('falls back to "unnamed" for empty suite names', () => {
      const suite = createSuite({ name: '   ' })

      const metrics = generateMetrics(createReport([suite]), config)
      const suiteDurations = byName(metrics, 'testsuite_duration_seconds')

      expect(suiteDurations[0]!.attributes['suite.id']).toBe('unnamed')
    })

    it('caps suite.id at 256 chars with the head...tail___hash scheme', () => {
      const longName = `Suite ${'x'.repeat(300)} end`
      const suite = createSuite({ name: longName })

      const metrics = generateMetrics(createReport([suite]), config)
      const suiteId = byName(metrics, 'testsuite_duration_seconds')[0]!
        .attributes['suite.id']!

      expect(suiteId.length).toBeLessThanOrEqual(256)
      expect(suiteId).toMatch(/^.+\.\.\..+___[a-f0-9]{8}$/)
      expect(suiteId).toContain('end')
    })
  })
})
