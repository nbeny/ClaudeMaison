// Bootstrap OpenTelemetry. Doit être importé AVANT tout autre module
// (avant `AppModule`, avant `NestFactory`) sinon les instrumentations qui
// patchent les modules au require ne voient pas le code applicatif.
//
// Si `OTEL_EXPORTER_OTLP_ENDPOINT` n'est pas défini, on n'enregistre rien et
// `start()` est un no-op : l'API @opentelemetry/api reste utilisable (les
// counters renvoient des handles no-op), c'est suffisant pour le dev local.

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { GraphQLInstrumentation } from '@opentelemetry/instrumentation-graphql';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.log('[otel] OTEL_EXPORTER_OTLP_ENDPOINT absent — télémétrie désactivée.');
    return;
  }
  if (sdk) {
    return; // déjà démarré
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'edge-api';
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
    // Sélection explicite plutôt que `auto-instrumentations-node` : on évite
    // de patcher des modules qu'on n'utilise pas (dns, net, mysql, etc.) et
    // on garde un bundle déterministe en CI.
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new GraphQLInstrumentation({
        // Ne pas inclure les variables : elles peuvent contenir des tokens
        // ou des PII selon les mutations.
        ignoreTrivialResolveSpans: true,
      }),
      new GrpcInstrumentation(),
      new IORedisInstrumentation(),
      new PgInstrumentation({
        // L'instrumentation pg n'inspecte pas le pool de `postgres` (porsager)
        // au niveau driver bas-niveau ; on garde l'instrumentation en place
        // au cas où un sous-module utiliserait `node-postgres` plus tard.
      }),
      new NestInstrumentation(),
    ],
  });

  sdk.start();

  console.log(`[otel] télémétrie active → ${endpoint} (service=${serviceName})`);
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('[otel] échec du shutdown SDK :', err);
  } finally {
    sdk = null;
  }
}
