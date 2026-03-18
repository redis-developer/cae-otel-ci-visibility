import * as core from '@actions/core'

import * as github from '@actions/github'
import { ingestDir } from './junit-parser.js'
import {
  generateMetrics,
  generateRunId,
  type TMetricsConfig
} from './metrics-generator.js'
import { MetricsSubmitter } from './metrics-submitter.js'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

const DEFAULT_EXPORT_INTERVAL_MS = 15000
const DEFAULT_TIMEOUT_MS = 30000
import {
  DiagConsoleLogger,
  DiagLogFunction,
  DiagLogLevel,
  DiagLogger,
  diag
} from '@opentelemetry/api'

import {
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'

class CapturingDiagLogger implements DiagLogger {
  private baseLogger: DiagConsoleLogger
  private capturedOutput: string = ''

  constructor() {
    this.baseLogger = new DiagConsoleLogger()
  }

  private capture(level: string, message: string, ...args: unknown[]) {
    const fullMessage = `[${level}] ${message} ${args.join(' ')}\n`
    this.capturedOutput += fullMessage
  }

  error: DiagLogFunction = (message: string, ...args: unknown[]) => {
    this.capture('ERROR', message, ...args)
    this.baseLogger.error(message, ...args)
  }

  warn: DiagLogFunction = (message: string, ...args: unknown[]) => {
    this.capture('WARN', message, ...args)
    this.baseLogger.warn(message, ...args)
  }

  info: DiagLogFunction = (message: string, ...args: unknown[]) => {
    this.capture('INFO', message, ...args)
    this.baseLogger.info(message, ...args)
  }

  debug: DiagLogFunction = (message: string, ...args: unknown[]) => {
    this.capture('DEBUG', message, ...args)
    this.baseLogger.debug(message, ...args)
  }

  verbose: DiagLogFunction = (message: string, ...args: unknown[]) => {
    this.capture('VERBOSE', message, ...args)
    this.baseLogger.verbose(message, ...args)
  }

  getCapturedOutput(): string {
    return this.capturedOutput
  }
}

export async function run(): Promise<void> {
  try {
    const logger = new CapturingDiagLogger()
    diag.setLogger(logger, DiagLogLevel.ERROR)

    const junitXmlFolder = core.getInput('junit-xml-folder', { required: true })
    const otlpEndpoint = core.getInput('otlp-endpoint', { required: true })
    const otlpHeaders = core.getInput('otlp-headers') || ''

    const headers = parseOtlpHeaders(otlpHeaders)

    const metricsNamespace = 'cae'
    const metricsVersion = 'v13'

    const repository = `${github.context.repo.owner}/${github.context.repo.repo}`
    const branch = github.context.ref.replace('refs/heads/', '')
    const commitSha = github.context.sha
    const runId = generateRunId()

    const config: TMetricsConfig = {
      repository,
      branch,
      commitSha,
      runId
    }

    core.info(`🔧 Configuring OpenTelemetry CI Visibility`)
    core.info(`   Repository: ${repository}`)
    core.info(`   Branch: ${branch}`)
    core.info(`   Commit: ${commitSha}`)
    core.info(`   Run ID: ${runId}`)
    core.info(`   JUnit XML Folder: ${junitXmlFolder}`)
    core.info(`   OTLP Endpoint: ${otlpEndpoint}`)

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: repository
    })

    const exporter = new OTLPMetricExporter({
      url: otlpEndpoint,
      headers,
      timeoutMillis: DEFAULT_TIMEOUT_MS,
      temporalityPreference: AggregationTemporalityPreference.CUMULATIVE
    })

    const readers = [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: DEFAULT_EXPORT_INTERVAL_MS
      })
    ]

    const meterProvider = new MeterProvider({
      resource,
      readers
    })

    const metricsSubmitter = new MetricsSubmitter(
      repository,
      meterProvider,
      metricsNamespace,
      metricsVersion
    )

    core.info(`📊 Processing JUnit XML files from: ${junitXmlFolder}`)

    const ingestResult = ingestDir(junitXmlFolder)

    if (!ingestResult.success) {
      core.error(`Failed to ingest JUnit XML files: ${ingestResult.error}`)
      return
    }

    const report = ingestResult.data

    if (report.testsuites.length === 0) {
      core.warning(`No test suites found in ${junitXmlFolder}`)
      return
    }

    const metricDataPoints = generateMetrics(report, config)
    core.info(
      `Generated ${metricDataPoints.length} metrics from ${report.testsuites.length} test suites`
    )
    metricsSubmitter.submitMetrics(metricDataPoints)

    core.info(
      `Summary: ${report.totals.tests} tests, ${report.totals.failed} failures, ${report.totals.error} errors, ${report.totals.skipped} skipped`
    )

    await meterProvider.forceFlush()

    const diagOutput = logger.getCapturedOutput()

    if (diagOutput.includes('metrics export failed')) {
      core.error(`❌ CI visibility metrics submission failed: ${diagOutput}`)
      core.setFailed(`Action failed: ${diagOutput}`)
    } else {
      core.info(`✅ CI visibility metrics submitted successfully`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    core.error(`❌ CI visibility metrics submission failed: ${errorMessage}`)
    core.setFailed(`Action failed: ${errorMessage}`)
  }
}

const parseOtlpHeaders = (headersInput: string): Record<string, string> => {
  if (!headersInput.trim()) {
    return {}
  }

  const headers: Record<string, string> = {}

  try {
    if (headersInput.trim().startsWith('{')) {
      return JSON.parse(headersInput)
    } else {
      const pairs = headersInput.split(',')
      for (const pair of pairs) {
        const [key, ...valueParts] = pair.split('=')
        if (key && valueParts.length > 0) {
          headers[key.trim()] = valueParts.join('=').trim()
        }
      }
    }
  } catch (parseError) {
    core.warning(
      `Failed to parse OTLP headers: ${parseError instanceof Error ? parseError.message : String(parseError)}`
    )
  }

  return headers
}
