# retrieval

RAG service + embedding service (Jour-1). FastAPI + Qdrant.

## Stack

- Python 3.12, uv, FastAPI, Qdrant client async
- Embedder : stub déterministe (SHA256 → vecteur). Sera remplacé par fastembed
  BGE-large-fr — voir ADR-0007.

## Run

```bash
uv sync --extra dev
cp .env.example .env
uv run python -m retrieval.main
```

Qdrant local : `docker run -p 6333:6333 qdrant/qdrant:v1.12.4`.

## Endpoints

| Méthode | Path              | Description                              |
| ------- | ----------------- | ---------------------------------------- |
| GET     | `/health`         | Liveness                                 |
| POST    | `/v1/embeddings`  | `{texts: [...]}` → vecteurs              |
| POST    | `/v1/index`       | `{points: [{text, metadata}]}` → upsert  |
| POST    | `/v1/search`      | `{query, top_k}` → top-k                 |

## Tests

```bash
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run mypy src
```

Les tests d'intégration Qdrant (testcontainers) viendront dans une suite séparée.
