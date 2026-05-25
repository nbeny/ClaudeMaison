"""FastAPI : /v1/embeddings et /v1/search.

Contrat volontairement minimal : pas de filtres complexes, pas de reranking.
On vise le bout-en-bout fonctionnel ; le tuning vient après.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from qdrant_client.http import models as qmodels

from retrieval.config import get_settings
from retrieval.embedding import EmbeddingStub
from retrieval.qdrant_client_factory import ensure_collection, get_client


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    dim: int


class IndexPoint(BaseModel):
    id: str | None = None
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class IndexRequest(BaseModel):
    points: list[IndexPoint] = Field(min_length=1, max_length=64)


class IndexResponse(BaseModel):
    ids: list[str]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=8, ge=1, le=64)


class SearchHit(BaseModel):
    id: str
    score: float
    text: str
    metadata: dict[str, Any]


class SearchResponse(BaseModel):
    hits: list[SearchHit]


def create_app(embedder: EmbeddingStub | None = None) -> FastAPI:
    settings = get_settings()
    embedder = embedder or EmbeddingStub()
    app = FastAPI(
        title='retrieval',
        version='0.0.1',
        docs_url='/docs' if settings.NODE_ENV != 'production' else None,
        redoc_url=None,
    )

    @app.get('/health')
    async def health() -> dict[str, str]:
        return {'status': 'ok'}

    @app.post('/v1/embeddings', response_model=EmbedResponse)
    async def embeddings(req: EmbedRequest) -> EmbedResponse:
        vectors = embedder.embed_batch(req.texts)
        return EmbedResponse(vectors=vectors, dim=embedder.dim)

    @app.post('/v1/index', response_model=IndexResponse)
    async def index(req: IndexRequest) -> IndexResponse:
        await ensure_collection(embedder.dim)
        client = get_client()
        ids = [p.id or str(uuid.uuid4()) for p in req.points]
        vectors = embedder.embed_batch([p.text for p in req.points])
        points = [
            qmodels.PointStruct(
                id=pid,
                vector=vec,
                payload={'text': p.text, **p.metadata},
            )
            for pid, vec, p in zip(ids, vectors, req.points, strict=True)
        ]
        await client.upsert(collection_name=settings.QDRANT_COLLECTION, points=points)
        return IndexResponse(ids=ids)

    @app.post('/v1/search', response_model=SearchResponse)
    async def search(req: SearchRequest) -> SearchResponse:
        client = get_client()
        try:
            qvec = embedder.embed(req.query)
            response = await client.query_points(
                collection_name=settings.QDRANT_COLLECTION,
                query=qvec,
                limit=req.top_k,
                with_payload=True,
            )
        except Exception as exc:  # qdrant lève des erreurs hétérogènes
            raise HTTPException(status_code=502, detail=f'qdrant: {exc}') from exc
        hits = [
            SearchHit(
                id=str(r.id),
                score=float(r.score),
                text=str((r.payload or {}).get('text', '')),
                metadata={k: v for k, v in (r.payload or {}).items() if k != 'text'},
            )
            for r in response.points
        ]
        return SearchResponse(hits=hits)

    return app
