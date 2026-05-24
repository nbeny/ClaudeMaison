# `infrastructure/docker/`

Conteneurisation locale et de référence.

## Fichiers

| Fichier | Rôle |
|---|---|
| `docker-compose.dev.yml` | Dépendances locales pour le développement (Postgres, Redis, Qdrant, NATS, MinIO) |
| `.env.example` | Variables utilisées par `docker-compose.dev.yml` ; copier en `.env` |

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

## Arrêt

```bash
docker compose -f docker-compose.dev.yml down            # arrête, garde les volumes
docker compose -f docker-compose.dev.yml down -v         # arrête ET supprime les données
```

## Ports exposés en local

| Service | Port hôte | Identifiants par défaut |
|---|---|---|
| Postgres | 5432 | `claudemaison` / `claudemaison` / db `claudemaison` |
| Redis | 6379 | — (sans mot de passe en dev) |
| Qdrant (HTTP) | 6333 | — |
| Qdrant (gRPC) | 6334 | — |
| NATS (client) | 4222 | — |
| NATS (monitoring) | 8222 | — |
| MinIO (API) | 9000 | `minioadmin` / `minioadmin` |
| MinIO (console) | 9001 | `minioadmin` / `minioadmin` |

Ces identifiants sont **uniquement pour le développement local**. Jamais en staging ou prod (Vault).
