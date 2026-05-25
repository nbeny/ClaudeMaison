"""Handlers de jobs Arq.

Chaque fonction prend `ctx: dict` (injecté par Arq) + ses arguments métier.
On garde les handlers purs en termes d'IO : ils utilisent un AsyncClient
préparé par `startup`, stocké dans `ctx`.
"""

from __future__ import annotations

from typing import Any

import httpx

from workers.config import get_settings
from workers.logging import get_logger

log = get_logger('workers.jobs')


async def ingest_document(
    ctx: dict[str, Any],
    *,
    text: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Indexe un document dans retrieval. Retourne l'id Qdrant attribué."""
    client: httpx.AsyncClient = ctx['http']
    payload = {'points': [{'text': text, 'metadata': metadata or {}}]}
    resp = await client.post('/v1/index', json=payload)
    resp.raise_for_status()
    body = resp.json()
    log.info('workers.ingest_document.ok', id=body['ids'][0])
    return {'id': body['ids'][0]}


async def startup(ctx: dict[str, Any]) -> None:
    s = get_settings()
    ctx['http'] = httpx.AsyncClient(base_url=s.RETRIEVAL_URL, timeout=s.HTTP_TIMEOUT_S)
    log.info('workers.startup', retrieval=s.RETRIEVAL_URL)


async def shutdown(ctx: dict[str, Any]) -> None:
    client: httpx.AsyncClient | None = ctx.get('http')
    if client is not None:
        await client.aclose()
    log.info('workers.shutdown')
