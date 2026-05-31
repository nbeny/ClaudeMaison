"""Caractérisation workers.jobs — invariants wire-shape + lifecycle.

Complète test_jobs.py qui ne couvrait que le happy/error path. Ce
fichier verrouille les invariants 'silencieux' qui causent des
régressions douloureuses :

  - URL exacte POST /v1/index. Si on tape /v1/documents par
    inadvertance, retrieval renvoie 404 et le job échoue sans diagnostic
    métier. Le test verrouille le path.

  - Forme exacte du payload : {points: [{text, metadata}]}. Pas
    {documents: ...}, pas {chunks: ...}. retrieval valide en Pydantic
    et rejette tout schéma non-conforme.

  - metadata=None doit envoyer {} (pas null, pas absent). retrieval
    s'attend à un objet pour metadata.

  - startup : client httpx créé avec base_url + timeout depuis Settings.
    Si on hardcodait l'URL ici, on perdrait la possibilité de basculer
    retrieval en preview cluster via variable d'env.

  - shutdown : aclose sur le client si présent. Tolère ctx vide (cas où
    startup a foiré avant d'attribuer 'http').
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from workers.config import get_settings
from workers.jobs import ingest_document, shutdown, startup


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _capture_handler() -> tuple[httpx.MockTransport, dict[str, Any]]:
    captured: dict[str, Any] = {}

    def _h(request: httpx.Request) -> httpx.Response:
        captured['method'] = request.method
        captured['path'] = request.url.path
        captured['body'] = request.read()
        return httpx.Response(200, json={'ids': ['x-1']})

    return httpx.MockTransport(_h), captured


class TestIngestDocumentWire:
    async def test_posts_to_v1_index(self) -> None:
        # CRITIQUE : tap /v1/documents = 404 silencieux côté retrieval.
        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='x')
        assert captured['path'] == '/v1/index'

    async def test_uses_post_method(self) -> None:
        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='x')
        assert captured['method'] == 'POST'

    async def test_payload_wraps_in_points_list(self) -> None:
        # Forme exacte : retrieval refuse autre chose.
        import json as _json

        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='hello', metadata={'k': 'v'})
        body = _json.loads(captured['body'])
        assert 'points' in body
        assert isinstance(body['points'], list)
        assert len(body['points']) == 1

    async def test_payload_contains_text_and_metadata(self) -> None:
        import json as _json

        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='hello', metadata={'k': 'v'})
        body = _json.loads(captured['body'])
        point = body['points'][0]
        assert point['text'] == 'hello'
        assert point['metadata'] == {'k': 'v'}

    async def test_none_metadata_defaults_to_empty_dict(self) -> None:
        # Pas None côté wire. retrieval attend un objet.
        import json as _json

        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='hello', metadata=None)
        body = _json.loads(captured['body'])
        assert body['points'][0]['metadata'] == {}

    async def test_omitted_metadata_defaults_to_empty_dict(self) -> None:
        # Même comportement quand le kwarg n'est PAS passé.
        import json as _json

        transport, captured = _capture_handler()
        client = httpx.AsyncClient(transport=transport, base_url='http://r.test')
        await ingest_document({'http': client}, text='hello')
        body = _json.loads(captured['body'])
        assert body['points'][0]['metadata'] == {}

    async def test_returns_first_id_from_response(self) -> None:
        # Le contrat de réponse retrieval : {ids: [...]} — on prend [0].
        def _h(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={'ids': ['abc', 'def']})

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(_h), base_url='http://r.test'
        )
        result = await ingest_document({'http': client}, text='x')
        assert result == {'id': 'abc'}


class TestStartupCreatesClient:
    async def test_startup_attaches_http_client_to_ctx(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        class _MockClient:
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw

        monkeypatch.setattr('workers.jobs.httpx.AsyncClient', _MockClient)
        ctx: dict[str, Any] = {}
        await startup(ctx)
        assert 'http' in ctx
        assert isinstance(ctx['http'], _MockClient)

    async def test_startup_uses_retrieval_url_from_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        class _MockClient:
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw

        monkeypatch.setattr('workers.jobs.httpx.AsyncClient', _MockClient)
        await startup({})
        assert captured['kwargs']['base_url'] == get_settings().RETRIEVAL_URL

    async def test_startup_uses_timeout_from_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Pas un timeout hardcodé. HTTP_TIMEOUT_S=30 par défaut, ce qui
        # est aligné avec la latence d'indexing+embedding côté retrieval.
        captured: dict[str, Any] = {}

        class _MockClient:
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw

        monkeypatch.setattr('workers.jobs.httpx.AsyncClient', _MockClient)
        await startup({})
        assert captured['kwargs']['timeout'] == get_settings().HTTP_TIMEOUT_S


class TestShutdown:
    async def test_shutdown_closes_client_if_present(self) -> None:
        client = AsyncMock(spec=httpx.AsyncClient)
        ctx: dict[str, Any] = {'http': client}
        await shutdown(ctx)
        client.aclose.assert_awaited_once()

    async def test_shutdown_noop_if_http_missing(self) -> None:
        # Cas où startup a échoué avant d'attribuer 'http'. shutdown
        # ne doit pas lever — sinon Arq se plaint au teardown et masque
        # l'erreur initiale de startup.
        await shutdown({})  # ne doit pas raise

    async def test_shutdown_noop_if_http_is_none(self) -> None:
        # Robustesse défensive — ctx['http']=None ne doit pas crasher.
        await shutdown({'http': None})
