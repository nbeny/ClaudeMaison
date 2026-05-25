# `infrastructure/docker/`

Conteneurisation locale et de référence.

## Fichiers

| Fichier                  | Rôle                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `docker-compose.dev.yml` | Dépendances locales pour le développement (Postgres, Redis, Qdrant, NATS, MinIO) |
| `.env.example`           | Variables utilisées par `docker-compose.dev.yml` ; copier en `.env`              |

## Démarrage rapide (services edge-api uniquement)

```bash
cd infrastructure/docker
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d postgres redis
```

## Démarrage complet (avec stack IA)

Active le profil `ai` pour Qdrant + NATS + MinIO :

```bash
docker compose -f docker-compose.dev.yml --profile ai up -d
```

## Démarrage des applications (profil `apps`)

Build et démarre les 7 binaires (edge-api, realtime, ai-core, retrieval,
tools, workers, inference-router). Le profil `apps` active aussi
automatiquement Qdrant et NATS dont les binaires dépendent :

```bash
docker compose -f docker-compose.dev.yml --profile apps up -d --build
```

Pour itérer sur **un seul binaire**, préférer `pnpm dev` ou `uv run` en
local plutôt que rebuilder l'image à chaque modif — le profil `apps` est
là pour les démos et smoke E2E.

Le raccourci `--profile full` active tout : `apps`, `ai`, `oidc`, `obs`.

## Arrêt

```bash
docker compose -f docker-compose.dev.yml down            # arrête, garde les volumes
docker compose -f docker-compose.dev.yml down -v         # arrête ET supprime les données
```

## Ports exposés en local

| Service              | Port hôte   | Identifiants / notes                                |
| -------------------- | ----------- | --------------------------------------------------- |
| Postgres             | 5432        | `claudemaison` / `claudemaison` / db `claudemaison` |
| Redis                | 6379        | — (sans mot de passe en dev)                        |
| Qdrant               | 6333 / 6334 | HTTP / gRPC                                         |
| NATS                 | 4222 / 8222 | client / monitoring                                 |
| MinIO                | 9000 / 9001 | `minioadmin` / `minioadmin` (API / console)         |
| Keycloak             | 8080        | profil `oidc` — `admin` / `admin`                   |
| edge-api             | 3000 / 5001 | profil `apps` — HTTP / gRPC                         |
| realtime             | 3100        | profil `apps` — HTTP + WS                           |
| ai-core              | 4000 / 5002 | profil `apps` — HTTP / gRPC                         |
| retrieval            | 4100        | profil `apps`                                       |
| tools                | 5005        | profil `apps` — gRPC                                |
| inference-router     | 4200        | profil `apps`                                       |
| Grafana              | 3001        | profil `obs` — anonyme (dev only)                   |
| Prometheus           | 9090        | profil `obs`                                        |
| OTel Collector       | 4317 / 4318 | profil `obs` — gRPC / HTTP                          |

Ces identifiants sont **uniquement pour le développement local**. Jamais en staging ou prod (Vault).
