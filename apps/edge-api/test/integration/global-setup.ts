import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// globalSetup Vitest : démarre les containers UNE FOIS pour toute la run
// d'intégration, publie les URLs via process.env. Les fichiers de tests
// récupèrent ces variables au moment de construire leurs services.
//
// Image Postgres alignée avec la prod (postgres:17-alpine). Le schéma SQL
// déclaratif est copié dans /docker-entrypoint-initdb.d/ : il est exécuté
// par le entrypoint au premier boot, et nous garantit que les tests
// touchent la même structure que celle versionnée dans le repo.

let postgresContainer: StartedTestContainer | undefined;
let redisContainer: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(here, '../../../../infrastructure/db/schema.sql');

  postgresContainer = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'test',
    })
    .withCopyFilesToContainer([
      { source: schemaPath, target: '/docker-entrypoint-initdb.d/00-schema.sql' },
    ])
    .withExposedPorts(5432)
    // Le entrypoint imprime deux fois "ready to accept connections" :
    // la première en mode init (avant d'exécuter les init scripts), la
    // seconde une fois le serveur final lancé. On attend la SECONDE
    // pour être sûr que le schéma est appliqué.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(60_000)
    .start();

  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(30_000)
    .start();

  const pgHost = postgresContainer.getHost();
  const pgPort = postgresContainer.getMappedPort(5432);
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);

  process.env.DATABASE_URL = `postgres://test:test@${pgHost}:${pgPort}/test`;
  process.env.REDIS_URL = `redis://${redisHost}:${redisPort}`;

  // Logger explicite : utile quand un test échoue, on voit dans quels
  // containers ils tournaient.
  // eslint-disable-next-line no-console
  console.log(`[integration] postgres → ${process.env.DATABASE_URL}`);
  // eslint-disable-next-line no-console
  console.log(`[integration] redis    → ${process.env.REDIS_URL}`);
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([
    postgresContainer?.stop({ timeout: 5_000 }),
    redisContainer?.stop({ timeout: 5_000 }),
  ]);
}
