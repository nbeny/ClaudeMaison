// Telemetry doit être importé en premier (cf. apps/edge-api/src/main.ts).
import { startTelemetry, shutdownTelemetry } from './telemetry';
startTelemetry();

import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { TokenVerifier } from './auth';
import { loadEnv } from './config/env';
import { NatsSubscriber } from './nats/subscriber';
import { ConnectionHub } from './ws/hub';
import { registerWsRoutes } from './ws/routes';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // En dev on garde pino-pretty si présent ; pas de transport fixé ici
      // pour ne pas imposer la dep en prod.
    },
    trustProxy: true,
  });

  await app.register(fastifyWebsocket, {
    // 1 Mo : suffisant pour des évènements LLM (tokens streamés). Au-delà
    // c'est un signal qu'on essaie de pousser quelque chose qui devrait
    // passer par S3 (download URL).
    options: { maxPayload: 1_048_576 },
  });

  const verifier = new TokenVerifier(env);
  const hub = new ConnectionHub();

  app.get('/health', async () => ({ status: 'ok', connections: hub.size() }));

  registerWsRoutes(app, { verifier, hub });

  const subscriber = new NatsSubscriber(env.NATS_URL, hub, (msg, extra) =>
    app.log.info(extra ?? {}, msg),
  );
  // Non-bloquant : si NATS n'est pas joignable au boot, on retente en boucle
  // côté driver. On accepte les connexions WS sans events pour l'instant
  // (Health=ok, mais events.> ne flow pas — c'est observable côté hub.size
  // versus broadcast deliveries).
  subscriber.start().catch((err) => {
    app.log.error({ err }, 'nats subscriber failed to start');
  });

  await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
  app.log.info({ port: env.HTTP_PORT }, 'realtime ready');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await subscriber.stop();
      await app.close();
      await shutdownTelemetry();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((err) => {
  console.error('realtime failed to bootstrap', err);
  process.exit(1);
});
