// Caractérisation realtime/telemetry.ts — variant minimal d'edge-api/telemetry.
//
// Différences critiques vs edge-api à verrouiller :
//
//   - Service name default = 'realtime' (pas 'edge-api'). Si on copiait
//     le fichier sans changer le default, les traces realtime
//     apparaîtraient sous service.name=edge-api dans Grafana et
//     l'analyse multi-service serait totalement cassée.
//
//   - Instrumentations RESTREINTES : HTTP + Fastify uniquement. PAS
//     de pg, ioredis, grpc, nestjs-core, graphql. Le service realtime
//     n'utilise pas ces libs ; les patcher inutilement augmente
//     surface d'instrumentation et risque de bugs upstream.
//
//   - PAS d'instrumentation NATS (l'instrumentation officielle n'existe
//     pas). Tracing NATS doit être manuel côté subscriber. C'est un
//     contrat documenté dans le code source.
//
//   - shutdownTelemetry NE catch PAS les erreurs (try/finally sans
//     catch) — différent d'edge-api. Sur realtime on préfère propager
//     pour ne pas masquer un bug d'export. Le finally reset sdk=null
//     quoi qu'il arrive.
//
//   - Pas de log "[otel] absent" : no-op TOTALEMENT silencieux.
//     Différent d'edge-api qui logue pour aider au debug dev.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  nodeSdkCtor, sdkStart, sdkShutdown,
  traceExporterCtor, metricExporterCtor, periodicReaderCtor,
  resourceCtor,
  httpInstrCtor, fastifyInstrCtor,
} = vi.hoisted(() => ({
  nodeSdkCtor: vi.fn(),
  sdkStart: vi.fn(),
  sdkShutdown: vi.fn(),
  traceExporterCtor: vi.fn(),
  metricExporterCtor: vi.fn(),
  periodicReaderCtor: vi.fn(),
  resourceCtor: vi.fn(),
  httpInstrCtor: vi.fn(),
  fastifyInstrCtor: vi.fn(),
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
  Resource: class { constructor(public attrs: unknown) { resourceCtor(attrs); } },
}));

vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME: 'deployment.environment.name',
}));

vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: class { constructor() { httpInstrCtor(); } },
}));
vi.mock('@opentelemetry/instrumentation-fastify', () => ({
  FastifyInstrumentation: class { constructor() { fastifyInstrCtor(); } },
}));

type TelemetryModule = typeof import('./telemetry');

let savedEnv: NodeJS.ProcessEnv;
let logSpy: ReturnType<typeof vi.spyOn>;

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
});

afterEach(() => {
  process.env = savedEnv;
  logSpy.mockRestore();
});

describe('startTelemetry — no-op silencieux sans endpoint', () => {
  it('no-op quand OTEL_EXPORTER_OTLP_ENDPOINT absent', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).not.toHaveBeenCalled();
  });

  it('no-op quand endpoint = chaîne vide', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = '';
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).not.toHaveBeenCalled();
  });

  it('TOTALEMENT silencieux (pas de log) — différent d\'edge-api', async () => {
    // realtime préfère le silence : le service tourne en background
    // d'un cluster K8s, on ne veut pas polluer stdout avec un log
    // qui apparaît à chaque pod restart.
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('startTelemetry — bootstrap', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
  });

  it('appelle NodeSDK + start()', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(sdkStart).toHaveBeenCalledTimes(1);
  });

  it('trace exporter cible endpoint + "/v1/traces"', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(traceExporterCtor).toHaveBeenCalledWith({
      url: 'http://otel:4318/v1/traces',
    });
  });

  it('metric exporter cible endpoint + "/v1/metrics"', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(metricExporterCtor).toHaveBeenCalledWith({
      url: 'http://otel:4318/v1/metrics',
    });
  });

  it('exportIntervalMillis = 15_000', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    const [opts] = periodicReaderCtor.mock.calls[0] as [{ exportIntervalMillis: number }];
    expect(opts.exportIntervalMillis).toBe(15_000);
  });
});

describe('startTelemetry — service.name default verrouillé "realtime"', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
  });

  it('service.name fallback à "realtime" (PAS "edge-api" ni "unknown_service")', async () => {
    // Régression CRITIQUE possible : copier/coller depuis edge-api
    // sans changer le default ferait apparaître les traces realtime
    // sous service.name=edge-api dans Grafana → confusion totale
    // entre les deux services dans l'analyse multi-service.
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.name']).toBe('realtime');
    expect(attrs['service.name']).not.toBe('edge-api');
  });

  it('service.version fallback à "dev"', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.version']).toBe('dev');
  });

  it('deployment.environment fallback à "development"', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['deployment.environment.name']).toBe('development');
  });

  it('respecte OTEL_SERVICE_NAME quand fourni', async () => {
    process.env.OTEL_SERVICE_NAME = 'realtime-shard-2';
    const mod = await loadFresh();
    mod.startTelemetry();
    const [attrs] = resourceCtor.mock.calls[0] as [Record<string, string>];
    expect(attrs['service.name']).toBe('realtime-shard-2');
  });
});

describe('startTelemetry — instrumentations minimales', () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
  });

  it('instrumente HTTP (upgrade WS passe par http server)', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(httpInstrCtor).toHaveBeenCalledTimes(1);
  });

  it('instrumente Fastify (les handlers HTTP/SSE)', async () => {
    const mod = await loadFresh();
    mod.startTelemetry();
    expect(fastifyInstrCtor).toHaveBeenCalledTimes(1);
  });

  it('le tableau d\'instrumentations ne contient EXACTEMENT que 2 entrées', async () => {
    // Contrat strict : pas d'auto-instrumentation, pas de pg/ioredis/
    // grpc/nest/graphql, pas de NATS (instrumentation officielle
    // inexistante). Si quelqu'un ajoute "juste GraphQLInstrumentation
    // au cas où", on perd la déterminisme et on patche un module
    // qu'on n'utilise pas.
    const mod = await loadFresh();
    mod.startTelemetry();
    const [opts] = nodeSdkCtor.mock.calls[0] as [{ instrumentations: unknown[] }];
    expect(opts.instrumentations).toHaveLength(2);
  });
});

describe('startTelemetry — idempotence (combined guard)', () => {
  it('deuxième appel noop (un seul SDK)', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    const mod = await loadFresh();
    mod.startTelemetry();
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(1);
    expect(sdkStart).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownTelemetry — propagation d\'erreur (différent d\'edge-api)', () => {
  it('no-op quand jamais démarré', async () => {
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

  it('PROPAGE l\'erreur de shutdown (pas de catch, différent d\'edge-api)', async () => {
    // edge-api catch et log ; realtime propage pour ne pas masquer
    // les bugs d'export en CI/canary. Une régression qui ajouterait
    // un catch ferait disparaître les erreurs réelles d'export.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    sdkShutdown.mockRejectedValueOnce(new Error('exporter pending'));
    const mod = await loadFresh();
    mod.startTelemetry();
    await expect(mod.shutdownTelemetry()).rejects.toThrow('exporter pending');
  });

  it('reset sdk=null MÊME quand shutdown raise (finally)', async () => {
    // Le finally garantit qu'on peut redémarrer après un shutdown
    // foireux. Sans ça, sdk resterait non-null → bloqué pour
    // toujours par l'idempotence-guard.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel:4318';
    sdkShutdown.mockRejectedValueOnce(new Error('boom'));
    const mod = await loadFresh();
    mod.startTelemetry();
    await mod.shutdownTelemetry().catch(() => {});
    mod.startTelemetry();
    expect(nodeSdkCtor).toHaveBeenCalledTimes(2);
  });
});
