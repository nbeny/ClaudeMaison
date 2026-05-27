"""Tests d'intégration fallback inference-router.

On utilise un vrai TestClient FastAPI branché sur un `httpx.AsyncClient` lui-même
piloté par `httpx.MockTransport` — pas de réseau, pas de respx, déterministe.

Couvre 4 invariants :
1. Network error sur primary → fallback automatique sur secondary (non-streaming).
2. Une fois le stream ouvert sur primary, AUCUN fallback (même si secondary
   serait disponible) — sémantique "first byte commits".
3. Tous les backends en panne → 503 + body {error, attempts}.
4. Bearer per-pick : token injecté UNIQUEMENT sur le backend qui a api_key_env.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from inference_router.config import BackendConfig
from inference_router.http import create_app
from inference_router.router import BackendRouter


def _build_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.AsyncClient:
    """AsyncClient sans réseau — toutes les requêtes passent par `handler`."""
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport, timeout=5.0)


@pytest.fixture
def app_with_fallback() -> tuple[TestClient, list[str]]:
    """Primary échoue (ConnectError), fallback répond 200."""
    call_log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        if host == 'primary.test':
            call_log.append('primary')
            raise httpx.ConnectError('primary down', request=req)
        if host == 'fallback.test':
            call_log.append('fallback')
            return httpx.Response(
                200,
                json={'choices': [{'message': {'content': 'from-fallback'}}]},
            )
        raise AssertionError(f'unexpected host: {host}')

    router = BackendRouter(
        {
            'm': [
                BackendConfig(url='http://primary.test:8000', priority=0),
                BackendConfig(url='http://fallback.test:8000', priority=1),
            ]
        }
    )
    client = _build_client(handler)
    app = create_app(router=router, http_client=client)
    return TestClient(app), call_log


@pytest.fixture
def app_streaming_primary() -> tuple[TestClient, list[str]]:
    """Primary stream OK 200 → fallback ne doit JAMAIS être appelé."""
    call_log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        if host == 'primary.test':
            call_log.append('primary')
            body = b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
            # On utilise `stream=ByteStream(...)` plutôt que `content=...` car
            # l'app appelle `client.send(req, stream=True)` puis `aiter_raw()`.
            # Avec `content=`, la Response est déjà "consommée" et aiter_raw
            # lève StreamConsumed.
            return httpx.Response(
                200,
                stream=httpx.ByteStream(body),
                headers={'content-type': 'text/event-stream'},
            )
        if host == 'fallback.test':
            call_log.append('fallback')
            return httpx.Response(500, json={'error': 'should-not-happen'})
        raise AssertionError(f'unexpected host: {host}')

    router = BackendRouter(
        {
            'm': [
                BackendConfig(url='http://primary.test:8000', priority=0),
                BackendConfig(url='http://fallback.test:8000', priority=1),
            ]
        }
    )
    client = _build_client(handler)
    app = create_app(router=router, http_client=client)
    return TestClient(app), call_log


@pytest.fixture
def app_all_fail() -> tuple[TestClient, list[str]]:
    """Tous les backends explosent en ConnectError."""
    call_log: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        call_log.append(host)
        raise httpx.ConnectError(f'{host} down', request=req)

    router = BackendRouter(
        {
            'm': [
                BackendConfig(url='http://primary.test:8000', priority=0),
                BackendConfig(url='http://fallback.test:8000', priority=1),
            ]
        }
    )
    client = _build_client(handler)
    app = create_app(router=router, http_client=client)
    return TestClient(app), call_log


@pytest.fixture
def app_bearer_isolation() -> tuple[TestClient, list[tuple[str, str | None]]]:
    """Primary sans api_key, fallback avec api_key_env=MY_KEY.

    On capture (host, Authorization-header) pour chaque hit.
    """
    seen: list[tuple[str, str | None]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        auth = req.headers.get('authorization')
        seen.append((host, auth))
        if host == 'primary.test':
            raise httpx.ConnectError('primary down', request=req)
        if host == 'fallback.test':
            return httpx.Response(200, json={'ok': True})
        raise AssertionError(f'unexpected host: {host}')

    router = BackendRouter(
        {
            'm': [
                BackendConfig(url='http://primary.test:8000', priority=0),
                BackendConfig(
                    url='http://fallback.test:8000',
                    priority=1,
                    api_key_env='MY_KEY',
                ),
            ]
        }
    )
    client = _build_client(handler)
    app = create_app(router=router, http_client=client)
    return TestClient(app), seen


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_network_error_on_primary_falls_back_to_secondary(
    app_with_fallback: tuple[TestClient, list[str]],
) -> None:
    client, call_log = app_with_fallback
    res = client.post(
        '/v1/chat/completions',
        json={'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert res.status_code == 200
    assert res.json()['choices'][0]['message']['content'] == 'from-fallback'
    # Les DEUX backends ont été tentés, dans l'ordre.
    assert call_log == ['primary', 'fallback']


def test_streaming_does_not_fallback_after_first_chunk(
    app_streaming_primary: tuple[TestClient, list[str]],
) -> None:
    client, call_log = app_streaming_primary
    with client.stream(
        'POST',
        '/v1/chat/completions',
        json={
            'model': 'm',
            'messages': [{'role': 'user', 'content': 'hi'}],
            'stream': True,
        },
    ) as r:
        assert r.status_code == 200
        chunks = b''.join(r.iter_bytes())
    assert b'hi' in chunks
    assert b'[DONE]' in chunks
    # Le fallback NE DOIT PAS avoir été appelé.
    assert call_log == ['primary']


def test_all_backends_failing_returns_503(
    app_all_fail: tuple[TestClient, list[str]],
) -> None:
    client, call_log = app_all_fail
    res = client.post(
        '/v1/chat/completions',
        json={'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert res.status_code == 503
    assert res.json() == {'error': 'all_backends_failed', 'attempts': 2}
    # Les deux backends ont bien été tentés avant l'abandon.
    assert call_log == ['primary.test', 'fallback.test']


def test_bearer_token_is_isolated_per_pick(
    app_bearer_isolation: tuple[TestClient, list[tuple[str, str | None]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv('MY_KEY', 'sk-test')
    client, seen = app_bearer_isolation
    res = client.post(
        '/v1/chat/completions',
        json={'model': 'm', 'messages': [{'role': 'user', 'content': 'hi'}]},
    )
    assert res.status_code == 200
    # On a bien tenté les deux, dans l'ordre.
    assert [host for host, _ in seen] == ['primary.test', 'fallback.test']
    # Primary n'a PAS de api_key_env → aucun Authorization.
    primary_auth = seen[0][1]
    assert primary_auth is None
    # Fallback a api_key_env=MY_KEY → Bearer sk-test.
    fallback_auth = seen[1][1]
    assert fallback_auth == 'Bearer sk-test'
