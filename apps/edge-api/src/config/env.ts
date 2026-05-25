import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_SIGNING_KEY: z.string().min(32),
  // Durées en secondes. Access court (15 min), refresh long (30 j).
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3001')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  // OIDC (étape 3). Optionnel : si OIDC_ISSUER_URL est absent, le module OIDC
  // ne s'enregistre pas et seul l'auth local fonctionne. Sinon, tout le bloc
  // est requis.
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  // URL du web client où rediriger après login OIDC réussi (tokens en fragment).
  OIDC_POST_LOGIN_REDIRECT: z.string().url().optional(),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  // Billing gRPC (étape 4). Le serveur gRPC ne démarre que si BILLING_GRPC_TOKEN
  // est défini ; c'est ce qui signe l'activation. Le token est partagé avec les
  // callers internes (ai-core, workers) — Jour-1 c'est un secret simple, plus
  // tard ce sera mTLS via le maillage de services.
  BILLING_GRPC_HOST: z.string().default('0.0.0.0'),
  BILLING_GRPC_PORT: z.coerce.number().int().positive().default(5001),
  BILLING_GRPC_TOKEN: z.string().min(32).optional(),

  GIT_COMMIT: z.string().optional(),
}).superRefine((env, ctx) => {
  // OIDC : tout-ou-rien. Si l'une des vars est fournie, toutes le doivent.
  const oidcKeys = [
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
  ] as const;
  const present = oidcKeys.filter((k) => env[k] !== undefined);
  if (present.length > 0 && present.length < oidcKeys.length) {
    const missing = oidcKeys.filter((k) => env[k] === undefined);
    for (const k of missing) {
      ctx.addIssue({
        code: 'custom',
        path: [k],
        message: `OIDC partiellement configuré : ${k} est requis quand les autres OIDC_* sont fournis.`,
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Variables d'environnement invalides ou manquantes :\n${formatted}`,
    );
  }
  return parsed.data;
}
