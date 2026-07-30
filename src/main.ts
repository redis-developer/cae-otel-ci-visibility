import * as core from '@actions/core'

import * as github from '@actions/github'
import { ingestDir, type TResult } from './junit-parser.js'
import {
  generateMetrics,
  type TMetricDataPoint,
  type TMetricsConfig
} from './metrics-generator.js'
import {
  detectNondeterministicTestIds,
  type TSuspiciousTestId
} from './nondeterminism-detector.js'
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
    const serverVersionInput = core.getInput('server-version') || ''
    const onNondeterministicIds = core.getInput('on-nondeterministic-ids') || ''

    // Config errors fail hard before any gating, so a misconfigured consumer
    // learns on the first run — even one on a branch that would not emit.
    const modeResult = parseNondeterministicIdsMode(onNondeterministicIds)
    if (!modeResult.success) {
      core.setFailed(modeResult.error)
      return
    }
    const nondeterministicIdsMode = modeResult.data

    const serverVersionResult = validateServerVersion(serverVersionInput)
    if (!serverVersionResult.success) {
      core.setFailed(serverVersionResult.error)
      return
    }
    const serverVersion = serverVersionResult.data

    const headers = parseOtlpHeaders(otlpHeaders)

    const metricsNamespace = 'cae'
    const metricsVersion = 'v16'

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
      branch,
      serverVersion
    }

    core.info(`🔧 Configuring OpenTelemetry CI Visibility`)
    core.info(`   Repository: ${repository}`)
    core.info(`   Branch: ${branch}`)
    if (serverVersion) {
      core.info(`   Server version: ${serverVersion}`)
    } else {
      core.info(
        `   Server version: (not set) — if this repo tests against multiple ` +
          `server versions, their results will be mixed together per test; ` +
          `set the server-version input to track each version separately`
      )
    }
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
    // Raw record() count is internal plumbing — logging it at info level
    // reads like a series count and alarms reviewers; series are logged below
    core.debug(
      `Generated ${metricDataPoints.length} metric data points from ${report.testsuites.length} test suites`
    )

    const enforcementResult = enforceNondeterministicTestIds(
      metricDataPoints,
      nondeterministicIdsMode
    )

    if (!enforcementResult.success) {
      core.setFailed(enforcementResult.error)
      return
    }

    const dataPointsToSubmit = enforcementResult.data

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

    const uniqueSeriesByMetric = countUniqueSeriesByMetric(dataPointsToSubmit)
    const testSeries = uniqueSeriesByMetric.get('test_duration_seconds') ?? 0
    const totalUniqueSeries = [...uniqueSeriesByMetric.values()].reduce(
      (sum, count) => sum + count,
      0
    )
    core.info(
      `Submitting one duration per distinct test: ${testSeries} distinct ` +
        `tests, plus ${totalUniqueSeries - testSeries} run/suite summary ` +
        `values. A test that ran more than once in this CI run (retries, ` +
        `matrix configurations) is still submitted as one test — the last ` +
        `parsed duration wins.`
    )

    for (const [metricName, uniqueSeries] of uniqueSeriesByMetric) {
      if (uniqueSeries > METRIC_CARDINALITY_LIMIT) {
        core.warning(
          `Metric ${metricName} tracks ${uniqueSeries} distinct label ` +
            `combinations, more than the limit of ${METRIC_CARDINALITY_LIMIT}. ` +
            `Everything past the limit is folded into a single "overflow" ` +
            `bucket, and those tests' individual durations are lost. This ` +
            `usually means test names embed run-varying values (ids, ` +
            `timestamps) — fix the test names so every test keeps its own history.`
        )
      }
    }

    // Full dump of what gets exported; visible with ACTIONS_STEP_DEBUG=true
    for (const dataPoint of dataPointsToSubmit) {
      core.debug(
        [
          'emit',
          dataPoint.metricName,
          describeDataPointId(dataPoint),
          `value=${dataPoint.value}`
        ]
          .filter(Boolean)
          .join(' ')
      )
    }

    metricsSubmitter.submitMetrics(dataPointsToSubmit)

    core.info(
      `Summary: ${report.totals.tests} test executions parsed — ` +
        `${report.totals.passed} passed, ${report.totals.failed} failed, ` +
        `${report.totals.error} errored, ${report.totals.skipped} skipped`
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

// The SDK's aggregationCardinalityLimit applies to unique attribute sets per
// instrument, not to record() calls — reruns of the same test land on one
// series, so only distinct attribute sets can overflow.
const countUniqueSeriesByMetric = (
  dataPoints: readonly TMetricDataPoint[]
): ReadonlyMap<string, number> => {
  const seriesByMetric = new Map<string, Set<string>>()

  for (const dataPoint of dataPoints) {
    const seriesKey = JSON.stringify(
      Object.entries(dataPoint.attributes).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    )
    const series = seriesByMetric.get(dataPoint.metricName) ?? new Set<string>()
    series.add(seriesKey)
    seriesByMetric.set(dataPoint.metricName, series)
  }

  return new Map(
    [...seriesByMetric].map(([metricName, series]) => [metricName, series.size])
  )
}

// Per-test points carry test.id, suite rollups suite.id, run-status rollups
// test.result.status; the run-duration rollup has none of the three.
const describeDataPointId = (dataPoint: TMetricDataPoint): string => {
  for (const key of ['test.id', 'suite.id', 'test.result.status'] as const) {
    const value = dataPoint.attributes[key]
    if (value !== undefined) {
      return `${key}="${value}"`
    }
  }
  return ''
}

type TNondeterministicIdsMode = 'warn' | 'skip' | 'break'

const NONDETERMINISTIC_IDS_MODES: readonly TNondeterministicIdsMode[] = [
  'warn',
  'skip',
  'break'
]

const parseNondeterministicIdsMode = (
  input: string
): TResult<TNondeterministicIdsMode> => {
  const mode = input.trim().toLowerCase() || 'warn'

  const match = NONDETERMINISTIC_IDS_MODES.find((known) => known === mode)
  if (match) {
    return { success: true, data: match }
  }

  return {
    success: false,
    error:
      `Invalid on-nondeterministic-ids value '${input}'. Allowed values: ` +
      `'warn' (default — report offenders, submit everything), ` +
      `'skip' (drop offenders' per-test data points, submit the rest), ` +
      `'break' (fail the build, upload nothing).`
  }
}

const MAX_REPORTED_SUSPICIOUS_IDS = 10

const formatSuspiciousTestIds = (
  suspicious: readonly TSuspiciousTestId[]
): string => {
  const preview = suspicious
    .slice(0, MAX_REPORTED_SUSPICIOUS_IDS)
    .map((entry) => `  - ${entry.testId} (${entry.reasons.join(', ')})`)
    .join('\n')
  const overflow =
    suspicious.length > MAX_REPORTED_SUSPICIOUS_IDS
      ? `\n  ...and ${suspicious.length - MAX_REPORTED_SUSPICIOUS_IDS} more`
      : ''

  return (
    `${suspicious.length} test id(s) look nondeterministic — these test ` +
    `names change on every run (embedded ids, timestamps, ports), so ` +
    `instead of extending one duration history per test they start a ` +
    `brand-new one on each run:\n` +
    `${preview}${overflow}`
  )
}

// A run-varying value in a test name (UUID, timestamp, port, temp path)
// mints a new series every run — the same churn the stable label schema
// removed. The mode decides how hard to push back; the real fix always
// belongs in the test names (or the reporter's name template).
const enforceNondeterministicTestIds = (
  metricDataPoints: readonly TMetricDataPoint[],
  mode: TNondeterministicIdsMode
): TResult<readonly TMetricDataPoint[]> => {
  const suspicious = detectNondeterministicTestIds(
    metricDataPoints.map((dataPoint) => dataPoint.attributes['test.id'])
  )

  if (suspicious.length === 0) {
    return { success: true, data: metricDataPoints }
  }

  const offenders = formatSuspiciousTestIds(suspicious)

  if (mode === 'break') {
    return {
      success: false,
      error:
        `${offenders}\n` +
        `Nothing was uploaded (on-nondeterministic-ids: break). Fix the ` +
        `test names (or the reporter's name template), or relax the mode ` +
        `to 'warn' or 'skip'.`
    }
  }

  if (mode === 'skip') {
    const suspiciousIds = new Set(suspicious.map((entry) => entry.testId))
    // Only per-test data points carry test.id; rollups pass through — they
    // have no test.id label, so a churning name is no cardinality risk
    // there, and dropping them would distort suite/run totals.
    const dataPoints = metricDataPoints.filter((dataPoint) => {
      const testId = dataPoint.attributes['test.id']
      return testId === undefined || !suspiciousIds.has(testId)
    })

    core.warning(
      `${offenders}\n` +
        `Skipping their per-test durations (on-nondeterministic-ids: ` +
        `skip); they still count toward the run/suite totals. Fix the test ` +
        `names (or the reporter's name template) to get their metrics back.`
    )

    return { success: true, data: dataPoints }
  }

  core.warning(
    `${offenders}\n` +
      `Fix the test names (or the reporter's name template) so each test ` +
      `keeps one continuous duration history.`
  )

  return { success: true, data: metricDataPoints }
}

const SERVER_VERSION_TRACK = /^\d+\.\d+$/

const SERVER_VERSION_ALLOWED =
  `Allowed values: 'unstable' (server built from master / under ` +
  `development) or a major.minor version track like '8.4'.`

// The server.version label multiplies series per test, so its values must be
// stable and bounded. Exactly two shapes are allowed: the literal 'unstable'
// and a 'major.minor' version track. Empty stays allowed — repos without a
// server under test simply omit the label.
const validateServerVersion = (input: string): TResult<string | undefined> => {
  const value = input.trim()

  if (!value) {
    return { success: true, data: undefined }
  }

  if (value === 'unstable' || SERVER_VERSION_TRACK.test(value)) {
    return { success: true, data: value }
  }

  const reject = (hint: string): TResult<string | undefined> => ({
    success: false,
    error: `Invalid server-version '${value}'. ${SERVER_VERSION_ALLOWED} ${hint}`
  })

  if (value.toLowerCase() === 'unstable') {
    return reject(`Use lowercase: 'unstable'.`)
  }

  const patchVersion = value.match(/^(\d+\.\d+)(?:\.\d+)+$/)
  if (patchVersion) {
    return reject(
      `Patch releases collapse into their version track — pass '${patchVersion[1]}'.`
    )
  }

  const suffixedVersion = value.match(/^(\d+\.\d+)(?:\.\d+)*[-+].+$/)
  if (suffixedVersion) {
    return reject(
      `Release candidates and previews collapse into their version track — pass '${suffixedVersion[1]}'.`
    )
  }

  return reject(
    `Image tags, commit SHAs and other run-varying values would mint new ` +
      `metric series every run — see the README section 'Server version convention'.`
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
