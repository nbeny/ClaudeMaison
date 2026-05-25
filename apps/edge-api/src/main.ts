import 'reflect-metadata';

import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validation explicite et précoce — fail-fast si la config est invalide.
  const env = loadEnv();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  await app.register(helmet, {
    // CSP par défaut désactivée tant qu'on n'a pas mesuré les besoins front.
    // Activée explicitement au commit qui câble le client web.
    contentSecurityPolicy: false,
  });

  await app.register(cors, {
    origin: env.ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Microservice gRPC pour le module billing. Démarrage conditionnel : tant
  // que BILLING_GRPC_TOKEN n'est pas défini, on n'expose pas l'endpoint —
  // c'est volontaire pour éviter qu'un déploiement sans secret laisse un
  // port ouvert qui accepterait toutes les écritures d'usage.
  if (env.BILLING_GRPC_TOKEN) {
    app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.GRPC,
        options: {
          url: `${env.BILLING_GRPC_HOST}:${env.BILLING_GRPC_PORT}`,
          package: 'claudemaison.billing.v1',
          protoPath: join(__dirname, '..', 'proto', 'billing.v1.proto'),
          loader: {
            keepCase: false,
            longs: Number,
            enums: String,
            defaults: false,
            oneofs: true,
          },
        },
      },
      { inheritAppConfig: true },
    );
    await app.startAllMicroservices();
    // eslint-disable-next-line no-console
    console.log(
      `billing gRPC écoute sur ${env.BILLING_GRPC_HOST}:${env.BILLING_GRPC_PORT}`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      'BILLING_GRPC_TOKEN non défini — endpoint gRPC billing désactivé.',
    );
  }

  app.enableShutdownHooks();

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`edge-api écoute sur http://0.0.0.0:${env.PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Échec du démarrage de edge-api :', err);
  process.exit(1);
});
