// Caractérisation telemetry.ts — bootstrap OTel.
//
// Invariants verrouillés :
//
//   - No-op silencieux (mais loggué) quand OTEL_EXPORTER_OTLP_ENDPOINT
//     est absent. Sans ça, dev local crasherait au boot si on a oublié
//     le env. Le contrat est : pas d'endpoint = pas de télémétrie, pas
//     d'erreur.
//
//   - Idempotence : deuxième appel à startTelemetry() est un no-op. On
//     ne veut pas démarrer deux SDK concurrents (double-export, leaks).
//
//   - URLs : exporter trace = endpoint + '/v1/traces', exporter metric
//     = endpoint + '/v1/metrics'. C'est la convention OTLP HTTP — un
//     suffixe faux fait 404 silencieusement côté collector.
//
//   - exportIntervalMillis = 15_000. Fréquence d'export métriques. Trop
//     court inonde le collector ; trop long fait perdre des métriques
//     en cas de crash. 15s est le compromis prod.
//
//   - Defaults : OTEL_SERVICE_NAME='edge-api', GIT_COMMIT='dev',
//     NODE_ENV='development'. Une régression de fallback ferait
//     apparaître les traces sous service.name='unknown_service' dans
//     Grafana — un cauchemar de debug.
//
//   - shutdownTelemetry : no-op si pas démarré, catch les erreurs sans
//     les propager (sinon process.exit handlers crashent), reset sdk à
//     null pour permettre un redémarrage propre (utile en tests).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  nodeSdkCtor, sdkStart, sdkShutdown,
  traceExporterCtor, metricExporterCtor, periodicReaderCtor,
  resourceCtor,
} = vi.hoisted(() => ({
  nodeSdkCtor: vi.fn(),
  sdkStart: vi.fn(),
  sdkShutdown: vi.fn(),
  traceExporterCtor: vi.fn(),
  metricExporterCtor: vi.fn(),
  periodicReaderCtor: vi.fn(),
  resourceCtor: vi.fn(),
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(opts: unknown) { nodeSdkCtor(opts); }
    start() { sdkStart(); }
    async shutdown() { return sdkShutdown(); }
  },
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    constructor(opts: unknown) { traceExporterCtor(opts); }
  },
}));

vi.mock('@opentelemetry/exporter-metrics-otlp-proto', () => ({
  OTLPMetricExporter: class {
    constructor(opts: unknown) { metricExporterCtor(opts); }
  },
}));

vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: class {
    constructor(opts: unknown) { periodicReaderCtor(opts); }
  },
}));

vi.mock('@opentelemetry/resources', () => ({
  Resource: class {
    constructor(public attrs: unknown) { resourceCtor(attrs); }
  },
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME: 'deployment.environment.name',
}));

// Stub minimal pour chaque instrumentation : la lib expose une classe
// avec un constructeur — on n'a pas besoin de plus pour ce test.
const noopInstrumentation = () => ({
  HttpInstrumentation: class { constructor() {} },
  FastifyInstrumentation: class { constructor() {} },
  GraphQLInstrumentation: class { constructor() {} },
  GrpcInstrumentation: class { constructor() {} },
  IORedisInstrumentation: class { constructor() {} },
  PgInstrumentation: class { constructor() {} },
  NestInstrumentation: class { constructor() {} },
});

vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: noopInstrumentation().HttpInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-fastify', () => ({
  FastifyInstrumentation: noopInstrumentation().FastifyInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-graphql', () => ({
  GraphQLInstrumentation: noopInstrumentation().GraphQLInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-grpc', () => ({
  GrpcInstrumentation: noopInstrumentation().GrpcInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-ioredis', () => ({
  IORedisInstrumentation: noopInstrumentation().IORedisInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-pg', () => ({
  PgInstrumentation: noopInstrumentation().PgInstrumentation,
}));
vi.mock('@opentelemetry/instrumentation-nestjs-core', () => ({
  NestInstrumentation: noopInstrumentation().NestInstrumentation,
}));

type TelemetryModule = typeof import('./telemetry');

let savedEnv: NodeJS.ProcessEnv;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

async function loadFresh(): Promise<TelemetryModule> {
  vi.resetModules();
  return await import('./telemetry');
}

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  delete process.env.GIT_COMMIT;
  delete process.env.NODE_ENV;
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = savedEnv;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('startTelemetry — no-op sans endpoint', () => {
  it('no-op total quand OTEL_EXPORTER_OTLP_ENDPOINT absent', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).not.toHaveBeenCalled();
    expect(sdkStart).not.toHaveBeenCalled();
  });

  it('logue le message "absent" pour aider au debug dev', async () => {
    // Sans ce log, le dev local pense que la télémétrie marche mais
    // rien n'est exporté.
    const mod = await loadFresh();
    mod.startTelemetry();
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('[otel]');
    expect(allLogs.toLowerCase()).toContain('absent');
  });

  it('no-op aussi quand endpoint = chaîne vide (truthy guard, pas null check)', async () => {
    // Important : si on faisait `if (endpoint === undefined)`, on
    // accepterait '' et OTLPExporter exploserait sur URL invalide.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).not.toHaveBeenCalled();
  });
});

describe('startTelemetry — bootstrap quand endpoint présent', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';
  });

  it('appelle NodeSDK puis sdk.start()', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(sdkStart).toHaveBeenCalledTimes(1);
  });

  it('trace exporter cible endpoint + "/v1/traces"', async () => {
    // OTLP HTTP path — un suffixe faux fait 404 silencieux côté
    // collector, on ne verrait jamais les spans en Grafana.
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(traceExporterCtor).toHaveBeenCalledWith({
      url: 'http://otel-collector:4318/v1/traces',
    });
  });

  it('metric exporter cible endpoint + "/v1/metrics"', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(metricExporterCtor).toHaveBeenCalledWith({
      url: 'http://otel-collector:4318/v1/metrics',
    });
  });

  it('exportIntervalMillis = 15_000 (compromis prod)', async () => {
    // Trop court : flood le collector. Trop long : perd les métriques
    // en cas de crash. 15s est le sweet spot.
    const mod = await loadFresh();
    mod.startTelemetry();
    const [opts] = periodicReaderCtor.mock.calls[0] as [{ exportIntervalMillis: number }];
    expect(opts.exportIntervalMillis).toBe(15_000);
  });
});

describe('startTelemetry — defaults de Resource', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
  });

  it('service.name fallback à "edge-api" quand OTEL_SERVICE_NAME absent', async () => {
    // Sans ce fallback, les traces apparaîtraient sous
    // service.name='unknown_service' dans Grafana → cauchemar debug.
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.name']).toBe('edge-api');
  });

  it('service.version fallback à "dev" quand GIT_COMMIT absent', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.version']).toBe('dev');
  });

  it('deployment.environment.name fallback à "development" quand NODE_ENV absent', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['deployment.environment.name']).toBe('development');
  });

  it('utilise OTEL_SERVICE_NAME quand fourni', async () => {
    process.env.OTEL_SERVICE_NAME = 'edge-api-canary';
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.name']).toBe('edge-api-canary');
  });

  it('utilise GIT_COMMIT comme service.version quand fourni', async () => {
    process.env.GIT_COMMIT = 'a1b2c3d';
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.version']).toBe('a1b2c3d');
  });

  it('utilise NODE_ENV quand fourni', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['deployment.environment.name']).toBe('production');
  });
});

describe('startTelemetry — idempotence', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
  });

  it('deuxième appel est un no-op (un seul SDK créé)', async () => {
    // Deux SDK concurrents → double export, leaks de ressources, et
    // potentiellement des sub-spans dupliqués côté collector.
    const mod = await loadFresh();
    mod.startTelemetry();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(sdkStart).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownTelemetry', () => {
  it('no-op (et ne raise pas) quand sdk jamais démarré', async () => {
    // Cas du dev local sans endpoint — process.exit handler appelle
    // shutdownTelemetry quand même. Ne doit pas péter.
    const mod = await loadFresh();
    await expect(mod.shutdownTelemetry()).resolves.toBeUndefined();
    expect(sdkShutdown).not.toHaveBeenCalled();
  });

  it('appelle sdk.shutdown() quand démarré', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    const mod = await loadFresh();
    mod.startTelemetry();
    await mod.shutdownTelemetry();
    expect(sdkShutdown).toHaveBeenCalledTimes(1);
  });

  it('reset le sdk à null — permet un redémarrage propre', async () => {
    // Utile pour les tests d'intégration qui veulent isoler runs.
    // Sans le reset, le 2e startTelemetry est bloqué par
    // l'idempotence-guard pour toujours.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    const mod = await loadFresh();
    mod.startTelemetry();
    await mod.shutdownTelemetry();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(2);
    expect(sdkStart).toHaveBeenCalledTimes(2);
  });

  it('catch les erreurs sans propager (process.exit handler stable)', async () => {
    // Pendant un crash, on appelle shutdownTelemetry dans le handler
    // SIGTERM. Si shutdown raise, on tue le handler et le process
    // peut hang. On veut absorber l'erreur.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    sdkShutdown.mockRejectedValueOnce(new Error('exporter pending flush'));
    const mod = await loadFresh();
    mod.startTelemetry();
    await expect(mod.shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('logue l\'erreur sur console.error pour observabilité', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    sdkShutdown.mockRejectedValueOnce(new Error('exporter down'));
    const mod = await loadFresh();
    mod.startTelemetry();
    await mod.shutdownTelemetry();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map((v) => String(v)).join(' ');
    expect(logged).toContain('[otel]');
  });

  it('reset sdk à null MÊME après une erreur (sinon plus jamais de restart)', async () => {
    // Si on ne resettait pas dans le finally, un shutdown échoué
    // laisserait sdk non-null et bloquerait à jamais le redémarrage.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    sdkShutdown.mockRejectedValueOnce(new Error('boom'));
    const mod = await loadFresh();
    mod.startTelemetry();
    await mod.shutdownTelemetry();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(2);
  });
});
