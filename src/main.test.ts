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
    eventName: 'push'
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
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
  SEMRESATTRS_SERVICE_NAMESPACE: 'service.namespace',
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT: 'deployment.environment'
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
          case 'service-name':
            return 'test-service'
          case 'service-namespace':
            return 'test-namespace'
          case 'service-version':
            return 'v1.0.0'
          case 'deployment-environment':
            return 'production'
          case 'otlp-endpoint':
            return 'http://localhost:4318/v1/metrics'
          case 'otlp-headers':
            return 'api-key=secret123,x-tenant=test'
          case 'otlp-protocol':
            return 'http/protobuf'
          default:
            return ''
        }
      }
    )

    await run()

    expect(mockCore.getInput).toHaveBeenCalledWith('junit-xml-folder', {
      required: true
    })
    expect(mockCore.getInput).toHaveBeenCalledWith('service-name', {
      required: true
    })
    expect(mockCore.getInput).toHaveBeenCalledWith('service-namespace', {
      required: true
    })
    expect(mockCore.getInput).toHaveBeenCalledWith('deployment-environment')
    expect(mockCore.getInput).toHaveBeenCalledWith('otlp-endpoint', {
      required: true
    })

    expect(mockResources.resourceFromAttributes).toHaveBeenCalledWith({
      'service.name': 'test-service',
      'service.namespace': 'test-namespace',
      'service.version': 'v1.0.0',
      'deployment.environment.name': 'production'
    })

    expect(mockOTLPExporter.OTLPMetricExporter).toHaveBeenCalledWith({
      aggregationPreference: expect.any(Function),
      url: 'http://localhost:4318/v1/metrics',
      headers: {
        'api-key': 'secret123',
        'x-tenant': 'test'
      },
      timeoutMillis: 30000
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
          case 'service-name':
            return 'test-service'
          case 'service-namespace':
            return 'test-namespace'
          case 'deployment-environment':
            return 'staging'
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
          case 'service-name':
            return 'test-service'
          case 'service-namespace':
            return 'test-namespace'
          case 'deployment-environment':
            return 'staging'
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
})
