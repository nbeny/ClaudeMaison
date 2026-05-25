# inference-router

Proxy OpenAI-compatible vers vLLM / llama.cpp. Routage par nom de modèle,
round-robin entre réplicas.

## Endpoints

| Méthode | Path                     |
| ------- | ------------------------ |
| GET     | `/health`                |
| GET     | `/v1/models`             |
| POST    | `/v1/chat/completions`   |
| POST    | `/v1/completions`        |
| POST    | `/v1/embeddings`         |

Le streaming SSE est supporté pour `chat/completions` quand `stream: true`.

## Configuration

`MODEL_BACKENDS` au format `nom=url1,url2;nom2=url3`. Exemple :

```
MODEL_BACKENDS=mistral-large-instruct=http://vllm-a:8000,http://vllm-b:8000;bge-large-fr=http://embedder:8001
```

## Run

```bash
uv sync --extra dev
cp .env.example .env
uv run python -m inference_router.main
```

## Tests

```bash
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run mypy src
```

## Limites Jour-1

- Pas de health-check actif des backends — un backend down sort de la rotation
  manuellement.
- Pas de quota / rate-limit par utilisateur (edge-api est censé gérer).
- Pas de retry / circuit breaker — on échoue vite, l'appelant retry.
