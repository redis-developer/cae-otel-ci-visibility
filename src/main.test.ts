import { jest } from '@jest/globals'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mockCore = {
  getInput: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  setFailed: jest.fn()
}

const mockGithub = {
  context: {
    repo: { owner: 'testowner', repo: 'testrepo' },
    ref: 'refs/heads/main',
    sha: 'abc123def456',
    runId: 12345,
    runNumber: 42,
    workflow: 'CI',
    actor: 'testuser',
    eventName: 'push',
    payload: { repository: { default_branch: 'main' } } as {
      repository?: { default_branch?: string }
    }
  }
}

const mockMeterProvider = {
  forceFlush: jest.fn().mockResolvedValue(undefined as never)
}

const mockOpenTelemetry = {
  MeterProvider: jest.fn(() => mockMeterProvider),
  PeriodicExportingMetricReader: jest.fn(() => ({})),
  ConsoleMetricExporter: jest.fn(() => ({})),
  AggregationType: {
    EXPONENTIAL_HISTOGRAM: 5
  }
}

const mockOTLPExporter = {
  OTLPMetricExporter: jest.fn(() => ({}))
}

const mockResources = {
  resourceFromAttributes: jest.fn(() => ({}))
}

const mockSemanticConventions = {
  ATTR_SERVICE_NAME: 'service.name'
}

const mockMetricsSubmitter = {
  submitMetrics: jest.fn()
}

jest.unstable_mockModule('@actions/core', () => mockCore)
jest.unstable_mockModule('@actions/github', () => mockGithub)
jest.unstable_mockModule('@opentelemetry/sdk-metrics', () => mockOpenTelemetry)
jest.unstable_mockModule(
  '@opentelemetry/exporter-metrics-otlp-proto',
  () => mockOTLPExporter
)
jest.unstable_mockModule('@opentelemetry/resources', () => mockResources)
jest.unstable_mockModule(
  '@opentelemetry/semantic-conventions',
  () => mockSemanticConventions
)
jest.unstable_mockModule('./metrics-submitter.js', () => ({
  MetricsSubmitter: jest.fn(() => mockMetricsSubmitter)
}))

const { run } = await import('./main.js')

describe('main.ts', () => {
  let testDir: string
  let junitXmlContent: string

  beforeAll(() => {
    junitXmlContent = readFileSync(
      'src/__test-fixtures__/junit-basic.xml',
      'utf-8'
    )
  })

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'junit-test-'))
    jest.clearAllMocks()
    mockGithub.context.ref = 'refs/heads/main'
    mockGithub.context.payload = { repository: { default_branch: 'main' } }
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('should correctly parse action.yml inputs and configure OpenTelemetry', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          case 'otlp-headers':
            return 'api-key=secret123,x-tenant=test'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.getInput).toHaveBeenCalledWith('junit-xml-folder', {
      required: true
    })
    expect(mockCore.getInput).toHaveBeenCalledWith('otlp-endpoint', {
      required: true
    })
    expect(mockCore.getInput).toHaveBeenCalledWith('otlp-headers')

    // Resource should use repository name as service name
    expect(mockResources.resourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'testowner/testrepo'
    })

    expect(mockOTLPExporter.OTLPMetricExporter).toHaveBeenCalledWith({
      url: 'http://localhost:4318/v1/metrics',
      headers: {
        'api-key': 'secret123',
        'x-tenant': 'test'
      },
      timeoutMillis: 30000,
      temporalityPreference: 1 // AggregationTemporalityPreference.CUMULATIVE
    })

    // Default SDK cardinality limit (2000) is below real suite sizes and
    // silently merges the excess into an otel.metric.overflow point
    expect(mockOpenTelemetry.MeterProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        views: [expect.objectContaining({ aggregationCardinalityLimit: 20000 })]
      })
    )

    expect(mockCore.info).toHaveBeenCalledWith(
      '✅ CI visibility metrics submitted successfully'
    )
  })

  it('should process JUnit XML files and submit test metrics', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.info).toHaveBeenCalledWith(
      `📊 Processing JUnit XML files from: ${testDir}`
    )

    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockMeterProvider.forceFlush).toHaveBeenCalled()
    expect(mockCore.info).toHaveBeenCalledWith(
      '✅ CI visibility metrics submitted successfully'
    )
  })

  it('should handle empty XML folder gracefully', async () => {
    mkdirSync(testDir, { recursive: true })

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.warning).toHaveBeenCalledWith(
      `No test suites found in ${testDir}`
    )
    expect(mockMetricsSubmitter.submitMetrics).not.toHaveBeenCalled()
  })

  it('should automatically derive repository, branch, and commit from GitHub context', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    // Verify GitHub context is logged
    expect(mockCore.info).toHaveBeenCalledWith(
      '   Repository: testowner/testrepo'
    )
    expect(mockCore.info).toHaveBeenCalledWith('   Branch: main')
    expect(mockCore.info).toHaveBeenCalledWith('   Commit: abc123def456')
  })

  it('should use hardcoded metrics namespace and version', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    // Should succeed with hardcoded values (cae, v16)
    expect(mockCore.info).toHaveBeenCalledWith(
      '✅ CI visibility metrics submitted successfully'
    )
  })

  it('should skip metrics emission on non-default branches by default', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)
    mockGithub.context.ref = 'refs/heads/feature-x'

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping metrics emission')
    )
    expect(mockOTLPExporter.OTLPMetricExporter).not.toHaveBeenCalled()
    expect(mockMetricsSubmitter.submitMetrics).not.toHaveBeenCalled()
    expect(mockCore.setFailed).not.toHaveBeenCalled()
  })

  it('should emit for branches in the branch-allowlist', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)
    mockGithub.context.ref = 'refs/heads/releases/v2'

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          case 'branch-allowlist':
            return 'main, releases/v2'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockCore.setFailed).not.toHaveBeenCalled()
  })

  it("should emit on any branch when branch-allowlist is '*'", async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)
    mockGithub.context.ref = 'refs/heads/feature-y'

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          case 'branch-allowlist':
            return '*'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
  })

  it('should warn when test ids look nondeterministic', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="1.0">
  <testsuite name="sessions" time="1.0">
    <testcase classname="client.session" name="reconnects after 3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e expires" time="0.5"/>
    <testcase classname="client.session" name="connects" time="0.5"/>
  </testsuite>
</testsuites>`
    writeFileSync(join(testDir, 'nondeterministic.xml'), xml)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('look nondeterministic')
    )
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e')
    )
    // Still submits — nondeterministic names are a warning, not a failure
    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockCore.setFailed).not.toHaveBeenCalled()
  })

  const nondeterministicXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="1.0">
  <testsuite name="sessions" time="1.0">
    <testcase classname="client.session" name="reconnects after 3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e expires" time="0.5"/>
    <testcase classname="client.session" name="connects" time="0.5"/>
  </testsuite>
</testsuites>`

  const mockInputs = (inputs: Record<string, string>) => {
    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => inputs[name] ?? ''
    )
  }

  it('should drop offending per-test data points in skip mode but keep rollups', async () => {
    writeFileSync(join(testDir, 'nondeterministic.xml'), nondeterministicXml)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics',
      'on-nondeterministic-ids': 'skip'
    })

    await run()

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('Skipping their per-test durations')
    )
    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockCore.setFailed).not.toHaveBeenCalled()

    const submitted = mockMetricsSubmitter.submitMetrics.mock
      .calls[0]![0] as readonly {
      metricName: string
      attributes: Record<string, string>
    }[]

    // The offending test's per-test point is gone, the clean one stays
    const testIds = submitted
      .map((dataPoint) => dataPoint.attributes['test.id'])
      .filter((testId) => testId !== undefined)
    expect(testIds).toEqual(['client.session.connects'])

    // Run/suite rollups (no test.id label) pass through untouched
    expect(
      submitted.some((dataPoint) => dataPoint.metricName === 'test_run_tests')
    ).toBe(true)
    expect(
      submitted.some(
        (dataPoint) => dataPoint.metricName === 'testsuite_duration_seconds'
      )
    ).toBe(true)
  })

  it('should fail the build and upload nothing in break mode', async () => {
    writeFileSync(join(testDir, 'nondeterministic.xml'), nondeterministicXml)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics',
      'on-nondeterministic-ids': 'break'
    })

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('look nondeterministic')
    )
    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining('3f2b8c9a-77aa-4bde-9c01-2f4a5b6c7d8e')
    )
    expect(mockMetricsSubmitter.submitMetrics).not.toHaveBeenCalled()
    expect(mockOTLPExporter.OTLPMetricExporter).not.toHaveBeenCalled()
  })

  it('should submit everything in skip/break modes when all ids are clean', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics',
      'on-nondeterministic-ids': 'break'
    })

    await run()

    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockCore.setFailed).not.toHaveBeenCalled()
  })

  it('should fail on an invalid on-nondeterministic-ids value', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics',
      'on-nondeterministic-ids': 'ignore'
    })

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid on-nondeterministic-ids value 'ignore'")
    )
    expect(mockMetricsSubmitter.submitMetrics).not.toHaveBeenCalled()
  })

  it.each(['8.10', '3.4', 'unstable'])(
    'should accept server-version %s',
    async (serverVersion) => {
      writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

      mockInputs({
        'junit-xml-folder': testDir,
        'otlp-endpoint': 'http://localhost:4318/v1/metrics',
        'server-version': serverVersion
      })

      await run()

      expect(mockCore.info).toHaveBeenCalledWith(
        `   Server version: ${serverVersion}`
      )
      expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
      expect(mockCore.setFailed).not.toHaveBeenCalled()
    }
  )

  // Raw rejected values stay out of the it.each titles: jest-junit writes
  // titles into this repo's own junit output, which the self-report run
  // feeds back through the detector — a literal SHA in a title gets flagged.
  it.each([
    { kind: 'a patch version', value: '8.4.0', hint: "pass '8.4'" },
    { kind: 'an rc suffix', value: '8.10-rc2', hint: "pass '8.10'" },
    {
      kind: 'a flavor prefix',
      value: 'rs-7.4',
      hint: 'Server version convention'
    },
    {
      kind: 'an image tag',
      value: 'latest',
      hint: 'Server version convention'
    },
    {
      kind: 'a git SHA',
      value: '3f2b8c9a77aa4bde9c012f4a5b6c7d8e1a2b3c4d',
      hint: 'Server version convention'
    },
    {
      kind: 'a timestamp',
      value: '2026-07-29T12:30:45Z',
      hint: 'Server version convention'
    }
  ])(
    'should reject server-version $kind with an actionable hint',
    async ({ value: serverVersion, hint: expectedHint }) => {
      writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

      mockInputs({
        'junit-xml-folder': testDir,
        'otlp-endpoint': 'http://localhost:4318/v1/metrics',
        'server-version': serverVersion
      })

      await run()

      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid server-version '${serverVersion}'`)
      )
      expect(mockCore.setFailed).toHaveBeenCalledWith(
        expect.stringContaining(expectedHint)
      )
      expect(mockMetricsSubmitter.submitMetrics).not.toHaveBeenCalled()
      expect(mockOTLPExporter.OTLPMetricExporter).not.toHaveBeenCalled()
    }
  )

  it('should fail on invalid server-version even when the branch gate would skip emission', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)
    mockGithub.context.ref = 'refs/heads/feature-x'

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics',
      'server-version': 'latest'
    })

    await run()

    expect(mockCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Invalid server-version 'latest'")
    )
  })

  it('should not warn for deterministic test ids', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('look nondeterministic')
    )
  })

  // The SDK cardinality limit counts unique attribute sets per instrument,
  // not record() calls — reruns of one test collapse into a single series.
  it('should not warn when many raw points collapse below the cardinality limit', async () => {
    const rerunTestcases = Array.from(
      { length: 21000 },
      () => '<testcase classname="BigSuite" name="test_rerun" time="0.001"/>'
    ).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="100.0">
  <testsuite name="BigSuite" time="100.0">
${rerunTestcases}
  </testsuite>
</testsuites>`
    writeFileSync(join(testDir, 'reruns.xml'), xml)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics'
    })

    await run()

    expect(mockCore.warning).not.toHaveBeenCalledWith(
      expect.stringContaining('distinct label combinations')
    )
    // 21000 per-test points + 4 run-status + 1 run-duration + 1 suite rollup
    // land on 1 + 6 unique series — the log must say so
    expect(mockCore.info).toHaveBeenCalledWith(
      expect.stringContaining(
        '1 distinct tests, plus 6 run/suite summary values'
      )
    )
    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
    expect(mockCore.setFailed).not.toHaveBeenCalled()
  }, 30000)

  it('should warn when one metric exceeds the cardinality limit in unique attribute sets', async () => {
    const uniqueTestcases = Array.from(
      { length: 20001 },
      (_, index) =>
        `<testcase classname="BigSuite" name="test_case_${index}" time="0.001"/>`
    ).join('\n')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites time="100.0">
  <testsuite name="BigSuite" time="100.0">
${uniqueTestcases}
  </testsuite>
</testsuites>`
    writeFileSync(join(testDir, 'unique.xml'), xml)

    mockInputs({
      'junit-xml-folder': testDir,
      'otlp-endpoint': 'http://localhost:4318/v1/metrics'
    })

    await run()

    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'Metric test_duration_seconds tracks 20001 distinct label combinations'
      )
    )
    expect(mockCore.warning).toHaveBeenCalledWith(
      expect.stringContaining('more than the limit of 20000')
    )
    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
  }, 30000)

  it('should emit when the default branch cannot be determined', async () => {
    writeFileSync(join(testDir, 'test-results.xml'), junitXmlContent)
    mockGithub.context.ref = 'refs/heads/whatever'
    mockGithub.context.payload = {}

    mockCore.getInput.mockImplementation(
      //@ts-expect-error - Mock implementation
      (name: string) => {
        switch (name) {
          case 'junit-xml-folder':
            return testDir
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockMetricsSubmitter.submitMetrics).toHaveBeenCalledTimes(1)
  })
})
