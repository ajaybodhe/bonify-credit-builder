/**
 * OpenTelemetry bootstrap.
 *
 * MUST start before anything else in the process — instrumentation works by
 * patching module exports, so a module loaded before the SDK starts is never
 * traced. Under ESM, imports are evaluated before any statement in the
 * importing module, so `src/index.ts` importing this "first" would be too late.
 * It is therefore PRELOADED with `node --import ./dist/telemetry/register.js`
 * and never imported from application code.
 *
 * Why OTel rather than a Prometheus client plus a separate tracing library: it
 * is one vendor-neutral wire format for all three pillars, so the collector —
 * not the application — decides where data lands. Swapping Grafana for Datadog
 * becomes a collector config change rather than a code change, which matters
 * more than it sounds when that decision is made after the code is written.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

let sdk: NodeSDK | undefined;

export function startTelemetry(): void {
  // Opt-in. Without an endpoint we stay silent rather than logging an export
  // failure every second, which is how observability ends up switched off.
  if (!process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'credit-builder',
      [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.0.0',
      'deployment.environment.name': process.env['NODE_ENV'] ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15_000,
    }),
    instrumentations: [
      // Probes are high-volume and carry no information; tracing them buries
      // the requests that matter.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => /^\/(health|ready|docs|openapi)/.test(req.url ?? ''),
      }),
      // Captures Banking API calls, since http.ts is undici-based.
      new UndiciInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });

  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  // Flush pending spans before exit, or the trace of the failure that caused
  // the shutdown is precisely the one you lose.
  await sdk?.shutdown();
}
