// Bootstrap OpenTelemetry — importé AVANT tout autre module pour que les
// instrumentations patchent au require. Même contrat que edge-api/telemetry.ts :
// no-op si OTEL_EXPORTER_OTLP_ENDPOINT n'est pas défini.

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Resource } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdk) return;

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'realtime';
  const serviceVersion = process.env.GIT_COMMIT ?? 'dev';
  const env = process.env.NODE_ENV ?? 'development';

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: env,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
    // Instrumentations strictement utiles : HTTP (upgrade WS passe par http
    // server) + Fastify (handlers). Pas de NATS ici — l'instrumentation
    // OTel/NATS officielle n'existe pas encore ; on tracera manuellement
    // côté subscriber.
    instrumentations: [new HttpInstrumentation(), new FastifyInstrumentation()],
  });

  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } finally {
    sdk = null;
  }
}
