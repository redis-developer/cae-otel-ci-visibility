import { jest } from '@jest/globals'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mockCore = {
  getInput: jest.fn(),
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

    // Should succeed with hardcoded values (cae, v14)
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
