"""Tests des handlers — on stub retrieval avec respx."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from workers.jobs import ingest_document


@pytest.fixture
def http_client() -> httpx.AsyncClient:
    transport = httpx.MockTransport(_handler)
    return httpx.AsyncClient(transport=transport, base_url='http://retrieval.test')


def _handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == '/v1/index' and request.method == 'POST':
        return httpx.Response(200, json={'ids': ['deadbeef']})
    return httpx.Response(404)


async def test_ingest_document_returns_id(http_client: httpx.AsyncClient) -> None:
    ctx: dict[str, Any] = {'http': http_client}
    result = await ingest_document(ctx, text='hello', metadata={'source': 'test'})
    assert result == {'id': 'deadbeef'}


async def test_ingest_document_raises_on_4xx() -> None:
    def bad(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={'detail': 'oops'})

    client = httpx.AsyncClient(transport=httpx.MockTransport(bad), base_url='http://x.test')
    with pytest.raises(httpx.HTTPStatusError):
        await ingest_document({'http': client}, text='x')
