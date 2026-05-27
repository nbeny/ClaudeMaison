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

## Démarrage local (llama.cpp + Mistral fallback)

Le routage Phase 1 attend un backend `llama-cpp` accessible sur
`http://llama-cpp:8080` (cf. `infrastructure/docker/docker-compose.dev.yml`,
profil `gpu`). Une fois la stack démarrée avec `--profile gpu`, télécharger
le modèle GGUF (une seule fois ; le volume `llama-models` est persistant) :

```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml exec llama-cpp \
  curl -L -o /models/mistral-7b-instruct-v0.3.Q4_K_M.gguf \
  https://huggingface.co/MaziyarPanahi/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q4_K_M.gguf
```

Puis relance le service `llama-cpp` pour qu'il monte le modèle :
`docker compose restart llama-cpp`.

Fallback Mistral (cloud EU) : poser `MISTRAL_API_KEY` dans
`infrastructure/docker/.env.dev`. Sans clé, `inference-router` ne sert
que le backend local.

## Limites Jour-1

- Pas de health-check actif des backends — un backend down sort de la rotation
  manuellement.
- Pas de quota / rate-limit par utilisateur (edge-api est censé gérer).
- Pas de retry / circuit breaker — on échoue vite, l'appelant retry.
