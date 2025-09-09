import {
  metrics,
  type MetricOptions,
  type Histogram,
  type Counter,
  type UpDownCounter
} from '@opentelemetry/api'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { TMetricDataPoint, TMetricsConfig } from './metrics-generator.js'

type TMetric = Histogram | Counter | UpDownCounter

export class MetricsSubmitter {
  private readonly meter
  private readonly histograms = new Map<string, Histogram>()
  private readonly counters = new Map<string, Counter>()
  private readonly upDownCounters = new Map<string, UpDownCounter>()
  private readonly namespace
  private readonly version

  constructor(
    config: TMetricsConfig,
    meterProvider: MeterProvider | undefined,
    namespace: string,
    version: string
  ) {
    if (meterProvider) {
      metrics.disable()
      metrics.setGlobalMeterProvider(meterProvider)
    }

    this.namespace = namespace
    this.version = version
    this.meter = metrics.getMeter(config.serviceName, config.serviceVersion)
  }

  public submitMetrics(metricDataPoints: readonly TMetricDataPoint[]): void {
    for (const dataPoint of metricDataPoints) {
      switch (dataPoint.metricType) {
        case 'histogram':
          this.recordHistogram(dataPoint)
          break
        case 'counter':
          this.incrementCounter(dataPoint)
          break
        case 'updowncounter':
          this.updateUpDownCounter(dataPoint)
          break
      }
    }
  }

  private getOrCreateMetric<T extends TMetric>(
    metricName: string,
    metricMap: Map<string, T>,
    createMetric: () => T
  ): T {
    if (!metricMap.has(metricName)) {
      metricMap.set(metricName, createMetric())
    }

    const metric = metricMap.get(metricName)
    if (!metric) {
      throw new Error(`Not found: ${metricName}`)
    }
    return metric
  }

  private createHistogramOptions(dataPoint: TMetricDataPoint): MetricOptions {
    const options: MetricOptions = {
      description: dataPoint.description,
      unit: dataPoint.unit
    }

    if (dataPoint.buckets) {
      options.advice = {
        explicitBucketBoundaries: dataPoint.buckets.concat()
      }
    }

    return options
  }

  private recordHistogram(dataPoint: TMetricDataPoint): void {
    const histogram = this.getOrCreateMetric(
      dataPoint.metricName,
      this.histograms,
      () =>
        this.meter.createHistogram(
          `${this.namespace}.${this.version}.${dataPoint.metricName}`,
          this.createHistogramOptions(dataPoint)
        )
    )

    histogram.record(dataPoint.value, dataPoint.attributes)
  }

  private incrementCounter(dataPoint: TMetricDataPoint): void {
    const counter = this.getOrCreateMetric(
      dataPoint.metricName,
      this.counters,
      () =>
        this.meter.createCounter(
          `${this.namespace}.${this.version}.${dataPoint.metricName}`,
          {
            description: dataPoint.description,
            unit: dataPoint.unit
          }
        )
    )

    counter.add(dataPoint.value, dataPoint.attributes)
  }

  private updateUpDownCounter(dataPoint: TMetricDataPoint): void {
    const upDownCounter = this.getOrCreateMetric(
      dataPoint.metricName,
      this.upDownCounters,
      () =>
        this.meter.createUpDownCounter(
          `${this.namespace}.${this.version}.${dataPoint.metricName}`,
          {
            description: dataPoint.description,
            unit: dataPoint.unit
          }
        )
    )

    upDownCounter.add(dataPoint.value, dataPoint.attributes)
  }
}
