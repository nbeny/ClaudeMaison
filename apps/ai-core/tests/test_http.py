"""Smoke tests sur la surface HTTP.

L'orchestrator reçoit un client d'inférence mocké : pas d'appel réseau,
mais on couvre le chemin complet HTTP → orchestrator → inference client.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from ai_core.http import create_app
from ai_core.inference import InferenceClient
from ai_core.orchestrator import Orchestrator


def _make_app(handler: Any) -> TestClient:
    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    inference = InferenceClient(
        base_url='http://router.test/v1', api_key='test', client=http_client
    )
    orchestrator = Orchestrator(inference=inference)
    return TestClient(create_app(orchestrator=orchestrator))


def _ok_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            'id': 'chatcmpl-1',
            'model': 'mistral-large-instruct',
            'choices': [
                {
                    'index': 0,
                    'message': {'role': 'assistant', 'content': 'Bonjour Alice.'},
                    'finish_reason': 'stop',
                }
            ],
        },
    )


@pytest.fixture
def stub_client() -> Iterator[TestClient]:
    yield _make_app(_ok_handler)


def test_health_returns_ok(stub_client: TestClient) -> None:
    res = stub_client.get('/health')
    assert res.status_code == 200
    assert res.json()['status'] == 'ok'


def test_turn_returns_inference_text(stub_client: TestClient) -> None:
    res = stub_client.post(
        '/v1/chat/turn',
        json={
            'workspace_id': 'ws-1',
            'user_id': 'u-1',
            'chat_id': 'c-1',
            'message': 'hello',
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body == {'chat_id': 'c-1', 'text': 'Bonjour Alice.', 'finish_reason': 'stop'}


def test_turn_returns_friendly_message_on_inference_error() -> None:
    def err(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={'error': 'backend down'})

    client = _make_app(err)
    res = client.post(
        '/v1/chat/turn',
        json={
            'workspace_id': 'ws-1',
            'user_id': 'u-1',
            'chat_id': 'c-1',
            'message': 'hello',
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body['finish_reason'] == 'error'
    assert 'indisponible' in body['text']


def test_turn_rejects_missing_fields(stub_client: TestClient) -> None:
    res = stub_client.post('/v1/chat/turn', json={'workspace_id': 'ws-1'})
    assert res.status_code == 422
