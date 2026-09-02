import { metrics } from '@opentelemetry/api';
import { vi } from 'vitest';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

/**
 * Captures the metrics the code under test emits.
 *
 * ## Why the import order matters
 *
 * `src/telemetry/metrics.ts` resolves its meter at module load. The OTel API
 * hands out a no-op meter when no global provider is registered yet, and that
 * decision is permanent for that module instance — registering a provider
 * afterwards does not retroactively wire up instruments that already exist.
 *
 * So a test cannot `import` the module under test at the top of the file: by
 * the time the helper runs, the instruments are already no-ops and every
 * assertion reads zero. `collectMetrics` therefore registers the provider
 * first and hands back an `import` function for use *after* that.
 *
 * For the same reason it resets the module registry. `src/telemetry/metrics.ts`
 * is a singleton, so a second test in the same file would otherwise reuse the
 * instruments the FIRST test bound — to a provider that has since been shut
 * down — and read zero for everything.
 */
export interface MetricsHarness {
  /** Import a module only after the provider is live. */
  load: <T>(specifier: string) => Promise<T>;
  /** Flush the reader and return the current value of one counter/histogram. */
  read: (name: string) => Promise<MetricPoint[]>;
  /** Sum of all data points for a metric, ignoring attributes. */
  total: (name: string) => Promise<number>;
  shutdown: () => Promise<void>;
}

export interface MetricPoint {
  attributes: Record<string, unknown>;
  /** Counter/gauge value, or a histogram's observation count. */
  value: number;
  /** Histograms only: the sum of recorded observations. */
  sum?: number;
}

export function collectMetrics(): MetricsHarness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A long interval so nothing exports on a timer; tests flush explicitly and
  // therefore never race the reader.
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 2 ** 30,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  vi.resetModules();

  const read = async (name: string): Promise<MetricPoint[]> => {
    await reader.forceFlush();
    const points: MetricPoint[] = [];
    for (const resourceMetric of exporter.getMetrics()) {
      for (const scope of resourceMetric.scopeMetrics) {
        for (const metric of scope.metrics) {
          if (metric.descriptor.name !== name) continue;
          for (const dp of metric.dataPoints) {
            const v = dp.value as number | { count: number; sum?: number };
            points.push(
              typeof v === 'number'
                ? { attributes: dp.attributes, value: v }
                : {
                    attributes: dp.attributes,
                    value: v.count,
                    ...(v.sum !== undefined && { sum: v.sum }),
                  },
            );
          }
        }
      }
    }
    return points;
  };

  return {
    load: <T>(specifier: string) => import(specifier) as Promise<T>,
    read,
    total: async (name) => (await read(name)).reduce((acc, p) => acc + p.value, 0),
    shutdown: async () => {
      await provider.shutdown();
      metrics.disable();
    },
  };
}

/** Finds the single point carrying every attribute in `match`. */
export function pointWith(
  points: readonly MetricPoint[],
  match: Record<string, unknown>,
): MetricPoint | undefined {
  return points.find((p) => Object.entries(match).every(([k, v]) => p.attributes[k] === v));
}
