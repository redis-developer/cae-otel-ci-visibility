import * as core from '@actions/core'
import * as github from '@actions/github'
import { ingestDir } from './junit-parser.js'
import { generateMetrics, type TMetricsConfig } from './metrics-generator.js'
import { MetricsSubmitter } from './metrics-submitter.js'
import {
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from '@opentelemetry/semantic-conventions'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAMESPACE
} from '@opentelemetry/semantic-conventions/incubating'

const DEFAULT_EXPORT_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 30000

export async function run(): Promise<void> {
  try {
    const junitXmlFolder = core.getInput('junit-xml-folder', { required: true })
    const serviceName = core.getInput('service-name', { required: true })
    const serviceNamespace = core.getInput('service-namespace', {
      required: true
    })
    const deploymentEnvironment =
      core.getInput('deployment-environment') || 'staging'
    const otlpEndpoint = core.getInput('otlp-endpoint', { required: true })

    const serviceVersion =
      core.getInput('service-version') || github.context.sha.substring(0, 8)
    const otlpHeaders = core.getInput('otlp-headers') || ''

    const headers = parseOtlpHeaders(otlpHeaders)

    const config: TMetricsConfig = {
      serviceName,
      serviceNamespace,
      serviceVersion,
      environment: deploymentEnvironment,
      repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
      branch: github.context.ref.replace('refs/heads/', ''),
      commitSha: github.context.sha,
      buildId: github.context.runId.toString()
    }

    core.info(`🔧 Configuring OpenTelemetry CI Visibility`)
    core.info(
      `   Service: ${serviceNamespace}/${serviceName} v${serviceVersion}`
    )
    core.info(`   Environment: ${deploymentEnvironment}`)
    core.info(`   JUnit XML Folder: ${junitXmlFolder}`)
    core.info(`   OTLP Endpoint: ${otlpEndpoint}`)

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_NAMESPACE]: serviceNamespace,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: deploymentEnvironment
    })

    const exporter = new OTLPMetricExporter({
      url: otlpEndpoint,
      headers,
      timeoutMillis: DEFAULT_TIMEOUT_MS
    })

    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: DEFAULT_EXPORT_INTERVAL_MS
        })
      ]
    })

    const metricsSubmitter = new MetricsSubmitter(config, meterProvider)

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

    core.info(`✅ CI visibility metrics submitted successfully`)
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
