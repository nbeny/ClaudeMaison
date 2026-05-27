"""FastAPI proxy OpenAI-compatible.

Endpoints couverts au Jour-1 :
- GET  /v1/models
- POST /v1/chat/completions  (streaming + non-streaming)
- POST /v1/completions
- POST /v1/embeddings

Le routage se fait par champ "model" du payload. Le corps est renvoyé tel
quel au backend — pas de re-validation OpenAI ici, on délègue.

Fallback : pour chaque modèle, on essaie les backends par groupe de priorité
(0 d'abord, round-robin intra-groupe). Sur ConnectError / ReadTimeout / 5xx
on tente le pick suivant. En streaming, le fallback n'est possible qu'avant
la première écriture vers le client (cf. spec).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from inference_router.config import get_settings, parse_model_backends
from inference_router.logging import get_logger
from inference_router.router import BackendPick, BackendRouter

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

    def _build_headers(base: dict[str, str], pick: BackendPick) -> dict[str, str]:
        """Copie défensive des headers + injection du Bearer si api_key_env.

        Per-pick : le token n'est PAS écrit dans `base`, donc pas de fuite
        vers le pick suivant si ce backend tombe en panne.
        """
        headers = dict(base)
        if pick.backend.api_key_env:
            key = os.environ.get(pick.backend.api_key_env)
            if key:
                headers['Authorization'] = f'Bearer {key}'
        return headers

    async def _try_backend(
        pick: BackendPick,
        body: dict[str, Any],
        path: str,
        fwd_headers: dict[str, str],
    ) -> httpx.Response | None:
        """Tente UNE requête non-streaming.

        Retourne la Response si status < 500. Retourne None sur erreur réseau
        ou status >= 500 — signal pour le caller de passer au pick suivant.
        """
        url = f'{pick.backend.url.rstrip("/")}{path}'
        headers = _build_headers(fwd_headers, pick)
        try:
            resp = await client.post(url, json=body, headers=headers)
        except (httpx.ConnectError, httpx.ReadTimeout):
            log.warning(
                'backend failed (network)',
                backend=pick.backend.url,
                provider=pick.backend.provider,
                group_index=pick.group_index,
            )
            return None
        if resp.status_code >= 500:
            log.warning(
                'backend failed (5xx)',
                backend=pick.backend.url,
                provider=pick.backend.provider,
                group_index=pick.group_index,
                status=resp.status_code,
            )
            return None
        return resp

    async def _open_stream(
        pick: BackendPick,
        body: dict[str, Any],
        path: str,
        fwd_headers: dict[str, str],
    ) -> httpx.Response | None:
        """Ouvre une réponse streaming. Renvoie None si retriable."""
        url = f'{pick.backend.url.rstrip("/")}{path}'
        headers = _build_headers(fwd_headers, pick)
        req = client.build_request('POST', url, json=body, headers=headers)
        try:
            resp = await client.send(req, stream=True)
        except (httpx.ConnectError, httpx.ReadTimeout):
            log.warning(
                'backend stream open failed (network)',
                backend=pick.backend.url,
                provider=pick.backend.provider,
                group_index=pick.group_index,
            )
            return None
        if resp.status_code >= 500:
            log.warning(
                'backend stream open failed (5xx)',
                backend=pick.backend.url,
                provider=pick.backend.provider,
                group_index=pick.group_index,
                status=resp.status_code,
            )
            await resp.aclose()
            return None
        return resp

    async def _proxy(request: Request, path: str) -> Any:
        body = await request.json()
        model = body.get('model')
        if not isinstance(model, str):
            raise HTTPException(status_code=400, detail='missing "model" field')
        try:
            picks = router.attempts(model)
        except KeyError:
            raise HTTPException(status_code=404, detail=f'unknown model: {model}') from None

        is_stream = bool(body.get('stream'))

        # Headers : on retire Host (httpx le gère), on retire aussi l'Authorization
        # entrante car le bearer du caller n'a aucun sens pour le backend cible.
        # L'auth backend est gérée par api_key_env dans BackendConfig.
        fwd_headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in {'host', 'content-length', 'authorization'}
        }

        if is_stream:
            # Cherche le premier pick capable d'OUVRIR une réponse <500.
            opened: httpx.Response | None = None
            for pick in picks:
                opened = await _open_stream(pick, body, path, fwd_headers)
                if opened is not None:
                    break

            if opened is None:
                # Tous les picks ont échoué AVANT le premier byte : on émet une
                # SSE d'erreur (preserve le content-type pour le client).
                async def err_gen() -> AsyncIterator[bytes]:
                    yield b'event: error\ndata: {"error": "all_backends_failed"}\n\n'

                return StreamingResponse(err_gen(), media_type='text/event-stream')

            response = opened

            async def gen() -> AsyncIterator[bytes]:
                try:
                    async for chunk in response.aiter_raw():
                        yield chunk
                finally:
                    await response.aclose()

            return StreamingResponse(gen(), media_type='text/event-stream')

        # Non-streaming : on essaie chaque pick, premier succès gagne.
        for pick in picks:
            resp = await _try_backend(pick, body, path, fwd_headers)
            if resp is not None:
                return JSONResponse(
                    status_code=resp.status_code,
                    content=resp.json() if resp.content else {},
                )

        return JSONResponse(
            status_code=503,
            content={'error': 'all_backends_failed', 'attempts': len(picks)},
        )

    return app
