"""FastAPI proxy OpenAI-compatible.

Endpoints couverts au Jour-1 :
- GET  /v1/models
- POST /v1/chat/completions  (streaming + non-streaming)
- POST /v1/completions
- POST /v1/embeddings

Le routage se fait par champ "model" du payload. Le corps est renvoyé tel
quel au backend — pas de re-validation OpenAI ici, on délègue.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from inference_router.config import get_settings, parse_model_backends
from inference_router.logging import get_logger
from inference_router.router import BackendRouter

log = get_logger('inference-router')


def create_app(router: BackendRouter | None = None) -> FastAPI:
    settings = get_settings()
    router = router or BackendRouter(parse_model_backends(settings.MODEL_BACKENDS))
    client = httpx.AsyncClient(timeout=settings.BACKEND_TIMEOUT_S)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await client.aclose()

    app = FastAPI(
        title='inference-router',
        version='0.0.1',
        docs_url='/docs' if settings.NODE_ENV != 'production' else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.client = client
    app.state.router = router

    @app.get('/health')
    async def health() -> dict[str, Any]:
        return {'status': 'ok', 'models': router.models()}

    @app.get('/v1/models')
    async def list_models() -> dict[str, Any]:
        return {
            'object': 'list',
            'data': [{'id': m, 'object': 'model', 'owned_by': 'local'} for m in router.models()],
        }

    @app.post('/v1/chat/completions')
    async def chat_completions(request: Request) -> Any:
        return await _proxy(request, '/v1/chat/completions')

    @app.post('/v1/completions')
    async def completions(request: Request) -> Any:
        return await _proxy(request, '/v1/completions')

    @app.post('/v1/embeddings')
    async def embeddings(request: Request) -> Any:
        return await _proxy(request, '/v1/embeddings')

    async def _proxy(request: Request, path: str) -> Any:
        body = await request.json()
        model = body.get('model')
        if not isinstance(model, str):
            raise HTTPException(status_code=400, detail='missing "model" field')
        try:
            backend = router.pick(model)
        except KeyError:
            raise HTTPException(status_code=404, detail=f'unknown model: {model}') from None

        is_stream = bool(body.get('stream'))
        url = f'{backend.rstrip("/")}{path}'

        # Headers : on retire Host (httpx le gère), on garde Authorization si présent
        # pour transmettre les credentials backend (par ex. clé pour vLLM auth).
        fwd_headers = {
            k: v for k, v in request.headers.items() if k.lower() not in {'host', 'content-length'}
        }

        if is_stream:

            async def gen() -> Any:
                req = client.build_request('POST', url, json=body, headers=fwd_headers)
                response = await client.send(req, stream=True)
                try:
                    async for chunk in response.aiter_raw():
                        yield chunk
                finally:
                    await response.aclose()

            return StreamingResponse(gen(), media_type='text/event-stream')

        resp = await client.post(url, json=body, headers=fwd_headers)
        # On préserve le code HTTP du backend (4xx propres pour le client).
        return JSONResponse(
            status_code=resp.status_code,
            content=resp.json() if resp.content else {},
        )

    return app
