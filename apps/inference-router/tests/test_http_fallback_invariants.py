"""Caractérisation invariants subtils du fallback HTTP inference-router.

test_fallback_integration.py couvre 4 invariants (network error fallback,
streaming first-byte-commit, all-fail 503, bearer per-pick). Ce fichier
verrouille les invariants plus fins du proxy.

  - **5xx déclenche fallback** : pas seulement les erreurs réseau. Un
    backend qui répond 502 est traité comme "down" et on passe au pick
    suivant. Critique car un proxy/reverse-proxy en panne devant un
    backend produit 502/504 — sans cet invariant, on ne ferait jamais
    de fallback dans ces cas.

  - **4xx propagé sans fallback** : 4xx = erreur du caller (bad payload,
    unsupported feature) → le fallback ne corrigerait rien. On renvoie
    le 4xx tel quel. Si on faisait fallback sur 4xx, on cascaderait
    sur des erreurs identiques et gonflerait la latence pour rien.

  - **Status code backend préservé bout-en-bout** : si le backend
    renvoie 422 (unprocessable entity), on renvoie 422 au client, pas
    une normalisation en 400 ou 500. Critique pour l'UX OpenAI-compat :
    le client (SDK officiel) traite 422 différemment de 400.

  - **Body vide → JSONResponse({})** : `resp.json() if resp.content else {}`
    — un backend qui renvoie 204 ou body vide ne fait pas crash JSON
    decode. Le client reçoit `{}` au lieu d'une 500 interne.

  - **Streaming all-fail → SSE error event au format exact** : le
    StreamingResponse rendu doit avoir media_type text/event-stream
    ET un body `event: error\\ndata: {"error":"all_backends_failed"}\\n\\n`.
    Si on changeait le format, les clients SSE EventSource le parseraient
    comme un "event:message" silencieux au lieu d'un event:error visible.

  - **Streaming 5xx open → fallback avant first byte** : symétrique du
    non-stream. Un 503 au "send headers" déclenche fallback. Différent
    de "fallback après chunk" qui est interdit.

  - **Default stream=false absent dans body** : `bool(body.get('stream'))`
    → si la clé `stream` est absente, on prend le chemin non-streaming.
    Si on remplaçait par `body.get('stream', True)`, le défaut deviendrait
    streaming et la majorité des clients OpenAI-compat se casseraient.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from inference_router.config import BackendConfig
from inference_router.http import create_app
from inference_router.router import BackendRouter


def _make_app(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    backends: list[BackendConfig] | None = None,
) -> TestClient:
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport, timeout=5.0)
    router = BackendRouter({
        'm': backends or [
            BackendConfig(url='http://primary.test:8000', priority=0),
            BackendConfig(url='http://fallback.test:8000', priority=1),
        ]
    })
    return TestClient(create_app(router=router, http_client=client))


class TestFiveXxTriggersFallback:
    """5xx (pas juste ConnectError) → pick suivant."""

    def test_502_on_primary_falls_back_to_secondary(self) -> None:
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            host = req.url.host
            call_log.append(host)
            if host == 'primary.test':
                return httpx.Response(502, json={'error': 'bad gateway'})
            return httpx.Response(200, json={'ok': True})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
        assert res.status_code == 200
        assert call_log == ['primary.test', 'fallback.test']

    def test_500_triggers_fallback(self) -> None:
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            host = req.url.host
            call_log.append(host)
            if host == 'primary.test':
                return httpx.Response(500)
            return httpx.Response(200, json={'ok': True})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 200
        assert call_log == ['primary.test', 'fallback.test']


class TestFourXxNoFallback:
    """4xx propagé sans cascade — c'est une erreur de payload."""

    def test_400_returned_to_caller_without_fallback(self) -> None:
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            call_log.append(req.url.host)
            return httpx.Response(400, json={'error': 'bad payload'})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 400
        # Un seul appel — pas de retry sur 4xx.
        assert call_log == ['primary.test']

    def test_422_returned_to_caller_without_fallback(self) -> None:
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            call_log.append(req.url.host)
            return httpx.Response(422, json={'detail': 'unprocessable'})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 422
        assert call_log == ['primary.test']

    def test_429_returned_to_caller_without_fallback(self) -> None:
        # Cas intéressant : 429 (rate limit) — un argument peut dire qu'on
        # devrait fallback. La spec actuelle dit non (c'est <500). On
        # verrouille le choix actuel pour ne pas changer silencieusement.
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            call_log.append(req.url.host)
            return httpx.Response(429, json={'error': 'rate limited'})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 429
        assert call_log == ['primary.test']


class TestStatusCodePassthrough:
    """Status code backend = status code response."""

    def test_201_passed_through(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(201, json={'created': True})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 201

    def test_409_passed_through(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(409, json={'error': 'conflict'})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 409


class TestEmptyResponseBody:
    """Body vide d'un backend → JSONResponse({}) — pas crash."""

    def test_empty_body_204_yields_empty_dict_response(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            # 204 No Content : body vide, mais on l'accepte (status<500).
            return httpx.Response(204)

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': [{'role': 'user', 'content': 'x'}]},
        )
        assert res.status_code == 204
        # FastAPI peut renvoyer un body vide pour 204.
        assert res.text in ('', '{}')


class TestStreamingAllFailSseFormat:
    """Stream all-fail → SSE event:error au format exact."""

    def test_stream_all_fail_returns_sse_content_type(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('down', request=req)

        tc = _make_app(handler)
        with tc.stream(
            'POST',
            '/v1/chat/completions',
            json={
                'model': 'm',
                'messages': [{'role': 'user', 'content': 'x'}],
                'stream': True,
            },
        ) as r:
            assert r.status_code == 200  # SSE error stream, not HTTP error
            content_type = r.headers.get('content-type', '')
            assert 'text/event-stream' in content_type

    def test_stream_all_fail_body_has_event_error_prefix(self) -> None:
        # Format exact : `event: error\ndata: {...}\n\n`. Si on enlevait
        # le `event: error`, EventSource le routerait comme 'message'.
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('down', request=req)

        tc = _make_app(handler)
        with tc.stream(
            'POST',
            '/v1/chat/completions',
            json={
                'model': 'm',
                'messages': [{'role': 'user', 'content': 'x'}],
                'stream': True,
            },
        ) as r:
            body = b''.join(r.iter_bytes())
        assert b'event: error' in body
        assert b'all_backends_failed' in body


class TestStreamingFiveXxOpenFallback:
    """En stream, 5xx au "open" → fallback avant first byte."""

    def test_stream_502_open_falls_back(self) -> None:
        # Primary répond 502 dès l'ouverture → fallback doit prendre la relève.
        call_log: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            host = req.url.host
            call_log.append(host)
            if host == 'primary.test':
                return httpx.Response(502, json={'error': 'bad gw'})
            return httpx.Response(
                200,
                stream=httpx.ByteStream(b'data: {"ok":1}\n\n'),
                headers={'content-type': 'text/event-stream'},
            )

        tc = _make_app(handler)
        with tc.stream(
            'POST',
            '/v1/chat/completions',
            json={
                'model': 'm',
                'messages': [{'role': 'user', 'content': 'x'}],
                'stream': True,
            },
        ) as r:
            assert r.status_code == 200
            body = b''.join(r.iter_bytes())
        # Fallback a bien été appelé après le 502 primary.
        assert call_log == ['primary.test', 'fallback.test']
        assert b'ok' in body


class TestStreamDefaultFalse:
    """body sans 'stream' → chemin non-streaming."""

    def test_no_stream_key_uses_nonstream_path(self) -> None:
        # Côté backend : on renvoie un JSON unique (non-streaming).
        # Si l'app prenait le path streaming par défaut, le test plant
        # dans aiter_raw sur une Response déjà consommée.
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={'choices': [{'message': {'content': 'x'}}]})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={
                'model': 'm',
                'messages': [{'role': 'user', 'content': 'x'}],
                # PAS de 'stream' du tout.
            },
        )
        assert res.status_code == 200
        # Le content-type doit être application/json (FastAPI default
        # JSONResponse), PAS text/event-stream.
        assert 'application/json' in res.headers.get('content-type', '')

    def test_stream_false_explicit_uses_nonstream_path(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={'ok': True})

        tc = _make_app(handler)
        res = tc.post(
            '/v1/chat/completions',
            json={
                'model': 'm',
                'messages': [{'role': 'user', 'content': 'x'}],
                'stream': False,
            },
        )
        assert res.status_code == 200
        assert 'application/json' in res.headers.get('content-type', '')
