import { MetricsSubmitter } from './metrics-submitter.js'
import type { TMetricDataPoint, TMetricsConfig } from './metrics-generator.js'
import { MeterProvider } from '@opentelemetry/sdk-metrics'
import {
  InMemoryMetricExporter,
  ResourceMetrics
} from '@opentelemetry/sdk-metrics'

import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { AggregationTemporality } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { setTimeout } from 'timers/promises'

const testResource = resourceFromAttributes({
  'service.name': 'test-service',
  'service.version': '1.0.0'
})

async function waitForNumberOfExports(
  exporter: InMemoryMetricExporter,
  numberOfExports: number
): Promise<ResourceMetrics[]> {
  if (numberOfExports <= 0) {
    throw new Error('numberOfExports must be greater than or equal to 0')
  }

  let totalExports = 0
  let attempts = 0
  const maxAttempts = 50

  while (totalExports < numberOfExports && attempts < maxAttempts) {
    await setTimeout(20)
    const exportedMetrics = exporter.getMetrics()
    totalExports = exportedMetrics.length
    attempts++
  }

  if (attempts >= maxAttempts) {
    throw new Error(
      `Timeout waiting for ${numberOfExports} exports after ${maxAttempts} attempts`
    )
  }
  return exporter.getMetrics()
}

function normalizeMetricsForSnapshot(
  exportedMetrics: ResourceMetrics[]
): unknown[] {
  return exportedMetrics.map((resourceMetric) => ({
    ...resourceMetric,
    scopeMetrics: resourceMetric.scopeMetrics.map((scopeMetric) => ({
      ...scopeMetric,
      metrics: scopeMetric.metrics.map((metric) => ({
        ...metric,
        dataPoints: metric.dataPoints.map((dataPoint) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { endTime, startTime, ...rest } = dataPoint

          return rest
        })
      }))
    }))
  }))
}

type TTestCase = {
  name: string
  metrics: readonly TMetricDataPoint[]
  expectExports?: number
}

describe('MetricsSubmitter', () => {
  let exporter: InMemoryMetricExporter
  let meterProvider: MeterProvider
  let metricReader: PeriodicExportingMetricReader
  let submitter: MetricsSubmitter

  const config: TMetricsConfig = {
    serviceName: 'test-service',
    serviceVersion: '1.0.0',
    environment: undefined,
    repository: undefined,
    branch: undefined,
    commitSha: undefined,
    runId: undefined,
    jobUUID: undefined
  }

  const createDataPoint = (
    overrides: Partial<TMetricDataPoint> = {}
  ): TMetricDataPoint => ({
    metricName: 'test.metric',
    metricType: 'counter',
    value: 1,
    attributes: { 'test.name': 'example' },
    description: 'Test metric',
    unit: '{test}',
    ...overrides
  })

  beforeEach(() => {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)

    metricReader = new PeriodicExportingMetricReader({
      exporter: exporter,
      exportIntervalMillis: 100,
      exportTimeoutMillis: 50
    })

    meterProvider = new MeterProvider({
      resource: testResource,
      readers: [metricReader]
    })
    submitter = new MetricsSubmitter(
      config,
      meterProvider,
      'test-namespace',
      'v1'
    )
  })

  afterEach(async () => {
    await exporter.shutdown()
    await metricReader.shutdown()
  })

  const testCases: readonly TTestCase[] = [
    {
      name: 'creates instruments for each metric type',
      metrics: [
        createDataPoint({
          metricName: 'test.duration',
          metricType: 'histogram',
          unit: 's'
        }),
        createDataPoint({
          metricName: 'test.status',
          metricType: 'counter',
          unit: '{test}'
        }),
        createDataPoint({
          metricName: 'test.suite.total',
          metricType: 'updowncounter',
          unit: '{test}'
        })
      ]
    },
    {
      name: 'configures histogram with explicit buckets',
      metrics: [
        createDataPoint({
          metricName: 'test.duration',
          metricType: 'histogram'
        })
      ]
    },
    {
      name: 'reuses existing instruments for same metric name',
      metrics: [
        createDataPoint({ metricName: 'test.counter', value: 1 }),
        createDataPoint({ metricName: 'test.counter', value: 2 })
      ]
    },
    {
      name: 'handles multiple metric types in one submission',
      metrics: [
        createDataPoint({
          metricName: 'test.histogram',
          metricType: 'histogram',
          value: 42
        }),
        createDataPoint({
          metricName: 'test.counter',
          metricType: 'counter',
          value: 10
        }),
        createDataPoint({
          metricName: 'test.updown',
          metricType: 'updowncounter',
          value: -5
        })
      ]
    },
    {
      name: 'handles metrics with different attributes correctly',
      metrics: [
        createDataPoint({
          metricName: 'test.counter',
          attributes: { env: 'dev', team: 'alpha' },
          value: 5
        }),
        createDataPoint({
          metricName: 'test.counter',
          attributes: { env: 'prod', team: 'beta' },
          value: 3
        })
      ]
    },
    {
      name: 'handles updowncounter negative values correctly',
      metrics: [
        createDataPoint({
          metricName: 'test.updown',
          metricType: 'updowncounter',
          value: 10
        }),
        createDataPoint({
          metricName: 'test.updown',
          metricType: 'updowncounter',
          value: -15
        })
      ]
    }
  ]

  for (const testCase of testCases) {
    it(`should ${testCase.name}`, async () => {
      submitter.submitMetrics(testCase.metrics)
      await metricReader.forceFlush()
      const expectedExports = testCase.expectExports ?? 1
      const exportedMetrics = await waitForNumberOfExports(
        exporter,
        expectedExports
      )
      expect(exportedMetrics.length).toBe(expectedExports)

      const normalizedMetrics = normalizeMetricsForSnapshot(exportedMetrics)
      expect(normalizedMetrics).toMatchSnapshot()
    })
  }

  it('should handle empty metrics array gracefully', async () => {
    submitter.submitMetrics([])
    expect(submitter).toBeDefined()
    await metricReader.forceFlush()
    const exportedMetrics = exporter.getMetrics()
    expect(exportedMetrics).toHaveLength(0)
  })
})
