# `edge-api`

Façade applicative pour les clients (web, mobile). Binaire Jour-1 qui regroupe trois modules logiques (ADR-0004) :

- `auth` — OIDC, sessions, JWT, RBAC
- `billing` — plans, quotas, événements d'usage
- `gateway` — surface GraphQL/REST/WS, routage interne

Spec détaillée : [`docs/specs/edge-api/design.md`](../../docs/specs/edge-api/design.md).

## Démarrage local

```bash
# 1. infra (depuis la racine du dépôt)
cd infrastructure/docker
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d postgres redis

# 2. installation des dépendances (depuis la racine du dépôt)
corepack enable
pnpm install

# 3. lancement en mode dev
cp apps/edge-api/.env.example apps/edge-api/.env
pnpm --filter edge-api dev
```

Le service écoute sur `http://localhost:3000` :

- `GET /health` — liveness
- `GET /ready` — readiness (vérifie Postgres + Redis)
- `POST /graphql` — endpoint GraphQL (UI Apollo à `/graphql` en dev)

## Tests

```bash
# Tests unitaires (Vitest, ~3s)
pnpm --filter edge-api test

# Tests d'intégration (testcontainers, Docker requis, ~15s)
pnpm --filter edge-api test:integration
```

Les tests d'intégration démarrent un Postgres + Redis éphémères via
testcontainers, appliquent le `schema.sql` au boot, et vérifient les
parcours auth (signup/refresh/réutilisation détectée) et billing (idempotence
des usage_events, calcul de quota). Docker Desktop (ou daemon Linux)
doit être disponible.

## Build production

```bash
pnpm --filter edge-api build
pnpm --filter edge-api start
```

## Image Docker

```bash
docker build -f apps/edge-api/Dockerfile -t edge-api:dev .
docker run --rm -p 3000:3000 --env-file apps/edge-api/.env edge-api:dev
```

## Structure

```
src/
├── main.ts                       # bootstrap (Fastify, logger, OTel, listen)
├── app.module.ts                 # racine NestJS
├── config/
│   └── env.ts                    # validation Zod des variables d'env
└── modules/
    ├── gateway/                  # configuration GraphQL globale
    ├── health/                   # /health, /ready (Terminus)
    ├── auth/                     # OIDC, JWT, sessions, viewer
    └── billing/                  # plans, quotas, événements d'usage
```

## Étapes restantes

Voir [§10 de la spec](../../docs/specs/edge-api/design.md#10-plan-dimplémentation-incrémental).
