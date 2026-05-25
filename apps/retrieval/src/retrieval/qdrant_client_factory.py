"""Wrapper minimal autour de qdrant-client.

On garde une seule instance par process (le client gère son pool HTTP).
La collection est créée à la volée si absente — pratique en dev, à durcir
quand on aura un job d'init côté infra.
"""

from __future__ import annotations

from functools import lru_cache

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qmodels

from retrieval.config import get_settings


@lru_cache(maxsize=1)
def get_client() -> AsyncQdrantClient:
    s = get_settings()
    return AsyncQdrantClient(url=s.QDRANT_URL, api_key=s.QDRANT_API_KEY)


async def ensure_collection(dim: int) -> None:
    client = get_client()
    name = get_settings().QDRANT_COLLECTION
    existing = await client.get_collections()
    if any(c.name == name for c in existing.collections):
        return
    await client.create_collection(
        collection_name=name,
        vectors_config=qmodels.VectorParams(size=dim, distance=qmodels.Distance.COSINE),
    )
