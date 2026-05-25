# workers

Jobs asynchrones — Arq + Redis. Jour-1 : `ingest_document` appelle retrieval.

## Stack

- Python 3.12, Arq 0.26
- Le binaire écoute Redis ; aucun port HTTP exposé.

## Run

```bash
uv sync --extra dev
cp .env.example .env
uv run python -m workers.main
```

Redis local : `docker run -p 6379:6379 redis:7-alpine`.

## Énqueuer un job (exemple depuis Python)

```python
import asyncio
from arq import create_pool
from arq.connections import RedisSettings

async def main():
    pool = await create_pool(RedisSettings.from_dsn('redis://localhost:6379/0'))
    await pool.enqueue_job('ingest_document', text='Bonjour le monde', metadata={})

asyncio.run(main())
```

## Tests

```bash
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run mypy src
```
