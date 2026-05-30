import { z } from 'zod';

// On reste minimaliste : un .env.example documente, Zod parse. Pas de
// nestjs/config ici puisque le binaire est Fastify nu — on consomme
// process.env via une factory une seule fois au boot.

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HTTP_PORT: z.coerce.number().int().positive().default(3100),
  HTTP_HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Doit matcher la clé utilisée par edge-api (HS256 partagée). Quand on
  // bascule en EdDSA on échangera une clé publique ici (JWT_PUBLIC_KEY) sans
  // toucher au flux de signature côté edge-api.
  JWT_SIGNING_KEY: z.string().min(32),
  JWT_ISSUER: z.string().default('claudemaison-edge-api'),
  JWT_AUDIENCE: z.string().default('claudemaison-clients'),

  // NATS JetStream est la dorsale d'événements (chat tokens, agent steps,
  // workers progress). En dev local : nats://localhost:4222.
  NATS_URL: z.string().default('nats://localhost:4222'),
  NATS_STREAM: z.string().default('events'),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('realtime'),

  // Edge-api URL pour l'ACL inter-services. En docker-compose : nom de
  // service interne. Le port 3000 est celui de l'app NestJS.
  EDGE_API_INTERNAL_URL: z.string().url().default('http://edge-api:3000'),
  // Secret partagé avec edge-api (header `x-internal-secret`). Doit matcher
  // INTERNAL_SHARED_SECRET côté edge-api.
  INTERNAL_SHARED_SECRET: z.string().min(32),

  // Optionnel : URL du realm Keycloak (ex: http://keycloak:8080/realms/cm-dev).
  // Si présent, realtime accepte aussi les access tokens RS256 émis par
  // Keycloak en plus des tokens HS256 d'edge-api. Indispensable au smoke E2E
  // qui présente directement un access token Keycloak (password grant).
  KEYCLOAK_ISSUER_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Échec au boot plutôt qu'à l'arrivée d'une connexion.
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment for realtime:\n  ${issues}`);
  }
  return parsed.data;
}
