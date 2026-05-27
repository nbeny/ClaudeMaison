import { ConfigService } from '@nestjs/config';
import postgres, { type Sql } from 'postgres';
import type { Env } from '../../src/config/env';
import { DatabaseService } from '../../src/database/database.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { FederatedIdentitiesRepository } from '../../src/modules/auth/federated-identities.repository';
import { JwtService } from '../../src/modules/auth/jwt.service';
import { PasswordService } from '../../src/modules/auth/password.service';
import { SessionsRepository } from '../../src/modules/auth/sessions.repository';
import { UsersRepository } from '../../src/modules/auth/users.repository';
import { BillingService } from '../../src/modules/billing/billing.service';
import { PlansRepository } from '../../src/modules/billing/plans.repository';
import { PlansSeeder } from '../../src/modules/billing/plans.seeder';
import { QuotaService } from '../../src/modules/billing/quota.service';
import { SubscriptionsRepository } from '../../src/modules/billing/subscriptions.repository';
import { UsageEventsRepository } from '../../src/modules/billing/usage-events.repository';
import { MetricsService } from '../../src/observability/metrics.service';

// Helpers partagés par les tests d'intégration. On évite de monter un
// TestingModule complet : on instancie à la main les briques dont on a
// besoin, c'est plus rapide et plus lisible. Quand le périmètre testé
// grandira (ex: tests E2E qui passent par GraphQL), on basculera sur
// `Test.createTestingModule({...}).compile()`.

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'warn',
    DATABASE_URL: process.env.DATABASE_URL!,
    REDIS_URL: process.env.REDIS_URL!,
    JWT_ISSUER: 'https://auth.test.local',
    JWT_AUDIENCE: 'claudemaison-test',
    JWT_SIGNING_KEY: 'test-signing-key-must-be-at-least-32-characters-long',
    JWT_ACCESS_TTL_SECONDS: 900,
    JWT_REFRESH_TTL_SECONDS: 60 * 60 * 24 * 30,
    ALLOWED_ORIGINS: ['http://localhost:3001'],
    OTEL_SERVICE_NAME: 'edge-api-test',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    OIDC_ISSUER_URL: undefined,
    OIDC_CLIENT_ID: undefined,
    OIDC_CLIENT_SECRET: undefined,
    OIDC_REDIRECT_URI: undefined,
    OIDC_POST_LOGIN_REDIRECT: undefined,
    BILLING_GRPC_HOST: '0.0.0.0',
    BILLING_GRPC_PORT: 5001,
    BILLING_GRPC_TOKEN: undefined,
    AI_CORE_URL: 'http://ai-core:5001',
    GIT_COMMIT: undefined,
    ...overrides,
  };
}

// ConfigService minimaliste : on lui passe directement l'Env, il sait ne
// pas appeler le validator. C'est ce que fait NestJS en interne quand
// validate() retourne déjà l'objet typé.
export function makeConfigService(env: Env = makeTestEnv()): ConfigService<Env, true> {
  return new ConfigService<Env, true>(env);
}

/**
 * Construit un DatabaseService réel branché sur le container Postgres en cours.
 * À détruire avec `db.onModuleDestroy()` à la fin de chaque `describe` pour
 * libérer le pool (sinon les processus de test pendent sur `vitest run`).
 */
export function makeDatabaseService(env: Env = makeTestEnv()): DatabaseService {
  return new DatabaseService(makeConfigService(env));
}

/**
 * Pool dédié au reset entre tests. Séparer ce pool du DatabaseService applicatif
 * évite que les TRUNCATE n'invalident les prepared statements actifs côté pool
 * applicatif.
 */
export function makeAdminSql(): Sql {
  return postgres(process.env.DATABASE_URL!, {
    max: 1,
    prepare: false,
    // Silence les NOTICEs de cascade (verbeux et sans valeur ici).
    onnotice: () => {},
  });
}

/**
 * Réinitialise toutes les tables applicatives à un état vide tout en
 * préservant les plans billing (seed indispensable au fallback `free` de
 * QuotaService). `RESTART IDENTITY CASCADE` remet les sequences, `CASCADE`
 * propage le TRUNCATE aux tables filles via FK.
 */
export async function resetDatabase(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE TABLE
      auth.federated_identities,
      auth.sessions,
      auth.users,
      billing.usage_events,
      billing.subscriptions
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * MetricsService réel — il fonctionne en no-op tant qu'aucun MeterProvider
 * global n'est enregistré, donc utilisable tel quel dans les tests.
 */
export function makeMetricsService(): MetricsService {
  return new MetricsService();
}

export interface AuthRig {
  authService: AuthService;
  users: UsersRepository;
  sessions: SessionsRepository;
  jwt: JwtService;
  db: DatabaseService;
}

export function buildAuthRig(env: Env = makeTestEnv()): AuthRig {
  const config = makeConfigService(env);
  const db = makeDatabaseService(env);
  const users = new UsersRepository(db);
  const sessions = new SessionsRepository(db);
  const federated = new FederatedIdentitiesRepository(db);
  const passwords = new PasswordService();
  const jwt = new JwtService(config);
  const metrics = makeMetricsService();
  const authService = new AuthService(
    config,
    users,
    sessions,
    passwords,
    jwt,
    db,
    federated,
    metrics,
  );
  return { authService, users, sessions, jwt, db };
}

export interface BillingRig {
  billing: BillingService;
  quota: QuotaService;
  plans: PlansRepository;
  subscriptions: SubscriptionsRepository;
  usage: UsageEventsRepository;
  db: DatabaseService;
}

export async function buildBillingRig(env: Env = makeTestEnv()): Promise<BillingRig> {
  const db = makeDatabaseService(env);
  const plans = new PlansRepository(db);
  const subscriptions = new SubscriptionsRepository(db);
  const usage = new UsageEventsRepository(db);
  const metrics = makeMetricsService();
  const quota = new QuotaService(plans, subscriptions, usage, metrics);
  const billing = new BillingService(usage, quota, metrics);
  // Seed des plans par défaut (free/pro/enterprise) — pré-requis pour le
  // fallback `free` de QuotaService et l'activation d'une subscription.
  await new PlansSeeder(plans).onApplicationBootstrap();
  return { billing, quota, plans, subscriptions, usage, db };
}
