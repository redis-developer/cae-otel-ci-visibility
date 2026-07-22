import * as core from '@actions/core'

import * as github from '@actions/github'
import { ingestDir } from './junit-parser.js'
import { generateMetrics, type TMetricsConfig } from './metrics-generator.js'
import { detectNondeterministicTestIds } from './nondeterminism-detector.js'
import { MetricsSubmitter } from './metrics-submitter.js'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

const DEFAULT_EXPORT_INTERVAL_MS = 15000
const DEFAULT_TIMEOUT_MS = 30000
// The SDK merges attribute sets beyond this limit into a single
// otel.metric.overflow=true data point, silently dropping per-test series.
// The default (2000) is below real suite sizes (2k–10k tests per repo).
const METRIC_CARDINALITY_LIMIT = 20000
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
    const branchAllowlist = core.getInput('branch-allowlist') || ''

    const headers = parseOtlpHeaders(otlpHeaders)

    const metricsNamespace = 'cae'
    const metricsVersion = 'v15'

    const repository = `${github.context.repo.owner}/${github.context.repo.repo}`
    const branch = github.context.ref.replace('refs/heads/', '')
    const commitSha = github.context.sha
    const payloadRepository = github.context.payload.repository
    const defaultBranch =
      typeof payloadRepository?.default_branch === 'string'
        ? payloadRepository.default_branch
        : undefined

    const config: TMetricsConfig = {
      repository,
      branch
    }

    core.info(`🔧 Configuring OpenTelemetry CI Visibility`)
    core.info(`   Repository: ${repository}`)
    core.info(`   Branch: ${branch}`)
    core.info(`   Commit: ${commitSha}`)
    core.info(`   JUnit XML Folder: ${junitXmlFolder}`)
    core.info(`   OTLP Endpoint: ${otlpEndpoint}`)

    const branchDecision = shouldEmitForBranch(
      branch,
      branchAllowlist,
      defaultBranch
    )

    if (!branchDecision.emit) {
      core.info(`⏭️ Skipping metrics emission: ${branchDecision.reason}`)
      return
    }

    core.info(`   Branch gate: ${branchDecision.reason}`)

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
      readers,
      views: [
        {
          instrumentName: '*',
          aggregationCardinalityLimit: METRIC_CARDINALITY_LIMIT
        }
      ]
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

    warnOnNondeterministicTestIds(metricDataPoints)

    if (metricDataPoints.length > METRIC_CARDINALITY_LIMIT) {
      core.warning(
        `${metricDataPoints.length} data points exceed the metric cardinality limit (${METRIC_CARDINALITY_LIMIT}); ` +
          `the excess is merged into a single otel.metric.overflow point and those tests' durations are lost`
      )
    }

    // Full dump of what gets exported; visible with ACTIONS_STEP_DEBUG=true
    for (const dataPoint of metricDataPoints) {
      core.debug(
        `emit ${dataPoint.metricName} test.id="${dataPoint.attributes['test.id']}" value=${dataPoint.value}`
      )
    }

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

const MAX_REPORTED_SUSPICIOUS_IDS = 10

// A run-varying value in a test name (UUID, timestamp, port, temp path)
// mints a new series every run — the same churn the stable label schema
// removed. Warn, don't fail: the fix belongs in the test names.
const warnOnNondeterministicTestIds = (
  metricDataPoints: readonly { attributes: Readonly<Record<string, string>> }[]
): void => {
  const suspicious = detectNondeterministicTestIds(
    metricDataPoints.map((dataPoint) => dataPoint.attributes['test.id'])
  )

  if (suspicious.length === 0) {
    return
  }

  const preview = suspicious
    .slice(0, MAX_REPORTED_SUSPICIOUS_IDS)
    .map((entry) => `  - ${entry.testId} (${entry.reasons.join(', ')})`)
    .join('\n')
  const overflow =
    suspicious.length > MAX_REPORTED_SUSPICIOUS_IDS
      ? `\n  ...and ${suspicious.length - MAX_REPORTED_SUSPICIOUS_IDS} more`
      : ''

  core.warning(
    `${suspicious.length} test id(s) look nondeterministic — run-varying values in test names mint a new metric series every run:\n` +
      `${preview}${overflow}\n` +
      `Fix the test names (or the reporter's name template) to keep metric cardinality bounded.`
  )
}

type TBranchDecision = {
  readonly emit: boolean
  readonly reason: string
}

// Branch names multiply against test.id cardinality, and short-lived branch
// values (PRs) never repeat — so by default metrics are emitted only for the
// repository default branch. An explicit allowlist overrides that; '*'
// disables gating entirely.
const shouldEmitForBranch = (
  branch: string,
  allowlistInput: string,
  defaultBranch: string | undefined
): TBranchDecision => {
  const allowlist = allowlistInput
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)

  if (allowlist.includes('*')) {
    return { emit: true, reason: "branch-allowlist is '*'" }
  }

  if (allowlist.length > 0) {
    if (allowlist.includes(branch)) {
      return { emit: true, reason: `branch '${branch}' is in the allowlist` }
    }

    return {
      emit: false,
      reason: `branch '${branch}' is not in the allowlist (${allowlist.join(', ')})`
    }
  }

  if (!defaultBranch) {
    return {
      emit: true,
      reason: `default branch is unknown for this event; emitting for branch '${branch}'`
    }
  }

  if (branch === defaultBranch) {
    return { emit: true, reason: `branch '${branch}' is the default branch` }
  }

  return {
    emit: false,
    reason: `branch '${branch}' is not the default branch '${defaultBranch}' (set branch-allowlist to override)`
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
