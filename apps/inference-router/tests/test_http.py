"""Tests HTTP — on stub les backends avec respx."""

from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from inference_router.http import create_app
from inference_router.router import BackendRouter


@pytest.fixture
def app_with_backend() -> TestClient:
    router = BackendRouter({'mistral-large': ['http://vllm.test:8000']})
    return TestClient(create_app(router=router))


def test_health_lists_models(app_with_backend: TestClient) -> None:
    res = app_with_backend.get('/health')
    assert res.status_code == 200
    assert res.json() == {'status': 'ok', 'models': ['mistral-large']}


def test_v1_models(app_with_backend: TestClient) -> None:
    res = app_with_backend.get('/v1/models')
    body = res.json()
    assert body['object'] == 'list'
    assert body['data'][0]['id'] == 'mistral-large'


def test_chat_completions_proxies_to_backend(app_with_backend: TestClient) -> None:
    with respx.mock:
        respx.post('http://vllm.test:8000/v1/chat/completions').mock(
            return_value=httpx.Response(200, json={'choices': [{'message': {'content': 'hi'}}]})
        )
        res = app_with_backend.post(
            '/v1/chat/completions',
            json={'model': 'mistral-large', 'messages': [{'role': 'user', 'content': 'hi'}]},
        )
    assert res.status_code == 200
    assert res.json()['choices'][0]['message']['content'] == 'hi'


def test_unknown_model_returns_404(app_with_backend: TestClient) -> None:
    res = app_with_backend.post('/v1/chat/completions', json={'model': 'nope', 'messages': []})
    assert res.status_code == 404


def test_missing_model_returns_400(app_with_backend: TestClient) -> None:
    res = app_with_backend.post('/v1/chat/completions', json={'messages': []})
    assert res.status_code == 400


def test_backend_4xx_is_propagated(app_with_backend: TestClient) -> None:
    with respx.mock:
        respx.post('http://vllm.test:8000/v1/chat/completions').mock(
            return_value=httpx.Response(429, json={'error': 'rate limit'})
        )
        res = app_with_backend.post(
            '/v1/chat/completions',
            json={'model': 'mistral-large', 'messages': []},
        )
    assert res.status_code == 429
    assert res.json() == {'error': 'rate limit'}
