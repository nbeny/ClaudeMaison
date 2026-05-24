# Spec — `edge-api`

> **Statut** : brouillon initial — 2026-05-24
> **Référence architecture** : [`docs/architecture/2026-05-24-architecture-souveraine.md`](../../architecture/2026-05-24-architecture-souveraine.md)
> **ADRs pertinents** : [0004](../../adr/0004-15-services-logiques-6-binaires.md), [0005](../../adr/0005-graphql-grpc-nats.md), [0008](../../adr/0008-sse-defaut-ws-vocal.md), [0011](../../adr/0011-github-runners-auto-heberges.md), [0012](../../adr/0012-vault-cosign-trivy-sbom.md)

## 1. Périmètre

`edge-api` est le **binaire Jour-1** qui regroupe trois modules logiques de l'architecture en un seul processus Node.js, conformément à l'ADR-0004 :

| Module logique | Rôle |
|---|---|
| `api-gateway` | Façade GraphQL pour clients, REST limité, terminaison WS, vérification JWT, propagation tracing |
| `auth-service` | OIDC, sessions, JWT, RBAC, introspection inter-services |
| `billing-service` | Plans, quotas, évènements d'usage, calcul des limites |

Les trois cohabitent dans `apps/edge-api/` avec des frontières internes claires (`src/modules/auth/`, `src/modules/billing/`, `src/modules/gateway/`) pour que l'extraction future soit mécanique.

## 2. Hors périmètre

| Ce qui n'est PAS dans `edge-api` | Où ça vit |
|---|---|
| Streaming long de tokens et d'évènements agents | `realtime` (binaire séparé) |
| Raisonnement, planification, exécution d'agents | `ai-core` |
| RAG, embeddings, ingestion | `retrieval`, `workers` |
| Exécution d'outils (shell, code, browser) | `tools` (sandboxing Firecracker) |
| Inférence LLM | plan d'inférence GPU via `inference-router` |

## 3. API exposée

### 3.1 GraphQL (chemin chaud client)

- Endpoint : `POST /graphql`
- Code-first via `@nestjs/graphql` + Apollo Driver.
- Schéma initial :
  ```graphql
  type Query {
    health: HealthStatus!
    viewer: Viewer
  }

  type HealthStatus {
    status: String!
    version: String!
    commit: String
  }

  type Viewer {
    id: ID!
    email: String!
    workspaces: [Workspace!]!
  }
  ```
- Le schéma s'enrichit au fil des commits (auth, billing, conversations).

### 3.2 REST (cas particuliers)

- `GET /health` — liveness, ne touche aucune dépendance, toujours 200 si le process tourne.
- `GET /ready` — readiness, vérifie Postgres + Redis.
- `POST /v1/uploads/init` — retourne une URL pré-signée MinIO (commit ultérieur).
- `POST /v1/webhooks/:provider` — webhooks tiers signés (commit ultérieur).

### 3.3 WebSocket

Réservé au mode vocal futur (ADR-0008). Aucun WS exposé au Jour-1.

## 4. Stack

| Couche | Choix |
|---|---|
| Runtime | Node.js 22 LTS |
| Framework | NestJS 11 sur **Fastify** (perf > Express) |
| GraphQL | `@nestjs/graphql` + Apollo Driver (code-first) |
| ORM | Drizzle (lite, type-safe) |
| Migrations | Atlas (déclaratif, lit le schéma Drizzle) |
| Redis | `ioredis` |
| JWT | `jose` |
| Validation env | Zod |
| Validation DTO REST | `class-validator` |
| Logs | `pino` via `nestjs-pino` |
| Tests | Vitest + Testcontainers pour intégration |
| Health | `@nestjs/terminus` |
| Tracing | OpenTelemetry SDK Node |

## 5. Modèle de données (extrait `edge-api`)

Tables possédées par ce binaire (schémas dans la base partagée) :

- `auth` : `users`, `workspaces`, `workspace_members`, `sessions`, `oidc_clients`
- `billing` : `plans`, `subscriptions`, `usage_events` (les lectures se font ici, l'écriture vient aussi de `ai-core` via gRPC interne)

Schémas SQL complets : voir [Partie VI §6.1 de l'architecture](../../architecture/2026-05-24-architecture-souveraine.md#61-postgresql--cœur-métier).

## 6. Configuration

Toutes les variables d'environnement sont **validées au boot** par un schéma Zod. Le process refuse de démarrer si une valeur manque ou est invalide.

| Variable | Description | Défaut |
|---|---|---|
| `NODE_ENV` | `development` / `staging` / `production` | `development` |
| `PORT` | port HTTP | `3000` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `DATABASE_URL` | DSN Postgres | — |
| `REDIS_URL` | URL Redis | — |
| `JWT_ISSUER` | issuer dans les JWT émis | — |
| `JWT_AUDIENCE` | audience attendue | — |
| `JWT_SIGNING_KEY` | clé HMAC ou chemin PEM RSA (lu depuis Vault en prod) | — |
| `ALLOWED_ORIGINS` | CSV pour CORS | `http://localhost:3001` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collecteur OTel | — |

## 7. Sécurité

- `@fastify/helmet` activé avec CSP par défaut strict.
- CORS basé sur `ALLOWED_ORIGINS`, jamais `*`.
- Rate-limit Fastify : 60 req/min/IP non authentifiée, 600 req/min/token authentifié.
- Validation Zod systématique sur tout payload entrant (REST et GraphQL inputs).
- Logs structurés `pino` avec **masquage** des champs sensibles (`password`, `token`, `authorization`, `cookie`).
- Aucun secret en clair dans l'environnement : en prod, lecture via Vault Agent qui matérialise les fichiers tmpfs.
- Cf. ADR-0012 pour la chaîne supply.

## 8. Observabilité

- OpenTelemetry SDK (`@opentelemetry/sdk-node`) initialisé avant Nest.
- Instrumentation auto : HTTP, GraphQL, ioredis, pg.
- Métriques custom : `http_request_duration_seconds`, `graphql_request_duration_seconds`, `auth_attempts_total`, `billing_quota_check_total`.
- `/ready` vérifie Postgres (`SELECT 1`) + Redis (`PING`) via `@nestjs/terminus`.

## 9. Stratégie de tests

| Niveau | Outil | Cible |
|---|---|---|
| Unitaire | Vitest | services, helpers (>80 % couvert) |
| Intégration | Vitest + Testcontainers (Postgres + Redis éphémères) | modules complets, schémas, contrats GraphQL |
| Contrat | Pact ou snapshot du schéma GraphQL | détection breaking change |
| E2E | Playwright (depuis `apps/web`) | parcours utilisateur réel |

## 10. Plan d'implémentation incrémental

| Étape | Contenu | Statut |
|---|---|---|
| 0 | Spec écrite | **fait (ce commit)** |
| 1 | Squelette NestJS bootable, `/health`, `/graphql` (avec `viewer` placeholder), Dockerfile, docker-compose dev (Postgres + Redis) | **fait (commit suivant)** |
| 2 | Module `auth` : inscription/connexion locales, JWT, schéma SQL initial, migrations Atlas | **fait** |
| 3 | Module `auth` : OIDC Authorization Code Flow + Keycloak self-hosted en compose | à venir |
| 4 | Module `billing` : plans, quotas, `usage_events`, intégration gRPC pour écriture depuis `ai-core` | à venir |
| 5 | Observabilité OTel complète + dashboards Grafana | à venir |
| 6 | Tests d'intégration Testcontainers + CI pipeline | à venir |

## 11. Critères de "Done" pour le binaire Jour-1

- [ ] `pnpm --filter edge-api dev` démarre localement.
- [ ] `GET /health` répond 200.
- [ ] `GET /ready` répond 200 quand Postgres + Redis sont up, 503 sinon.
- [ ] `POST /graphql` accepte `{ query: "{ viewer { id email } }" }` et renvoie une réponse typée.
- [ ] Image Docker construite et signée Cosign.
- [ ] Helm chart déployable sur cluster `dev`.
- [ ] Tests unitaires verts en CI.
- [ ] Spec d'auth (étape 2) prête à être implémentée.
