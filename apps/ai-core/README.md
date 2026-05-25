# `ai-core`

Binaire Python du Jour-1 hébergeant la boucle d'orchestration LLM, le runtime
d'agents et le memory-service. Stack : Python 3.12 + FastAPI + grpcio + NATS +
asyncpg + qdrant-client.

État actuel : scaffold bootable, HTTP `POST /v1/chat/turn` renvoie un écho.
À enrichir : memory recall, planner/critic agents, inference-router client.

## Démarrage local

Pré-requis : [`uv`](https://docs.astral.sh/uv/) ≥ 0.10.

```bash
cp apps/ai-core/.env.example apps/ai-core/.env
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile ai up -d
cd apps/ai-core
uv sync --extra dev
uv run ai-core
```

Vérif :

```bash
curl http://localhost:4000/health
curl -X POST http://localhost:4000/v1/chat/turn \
  -H 'content-type: application/json' \
  -d '{"workspace_id":"w","user_id":"u","chat_id":"c","message":"hello"}'
```

## Layout

| Module                 | Rôle                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `ai_core.config`       | pydantic-settings — fail-fast au boot si var critique manquante |
| `ai_core.logging`      | structlog — JSON en prod, console color en dev                  |
| `ai_core.telemetry`    | OTel SDK — no-op si OTLP endpoint absent                        |
| `ai_core.orchestrator` | Boucle de raisonnement (stub Jour-1, à enrichir)                |
| `ai_core.http`         | App FastAPI : /health, /v1/chat/turn                            |

## Tests

```bash
uv run pytest                  # unit
uv run ruff check .            # lint
uv run ruff format --check .   # format
uv run mypy src                # types stricts
```

## Production

Image Docker `apps/ai-core/Dockerfile` (multi-stage uv). Chart Helm à venir
dans `infrastructure/helm/ai-core/` sur le patron edge-api.
