"""Smoke tests sur la surface HTTP. Pas de LLM réel ici — l'orchestrator stub
renvoie un écho déterministe, c'est suffisant pour valider le câblage."""

from fastapi.testclient import TestClient

from ai_core.http import create_app


def test_health_returns_ok() -> None:
    client = TestClient(create_app())
    res = client.get('/health')
    assert res.status_code == 200
    assert res.json()['status'] == 'ok'


def test_turn_echoes_message() -> None:
    client = TestClient(create_app())
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
    assert body['chat_id'] == 'c-1'
    assert body['text'] == 'echo: hello'
    assert body['finish_reason'] == 'stop'


def test_turn_rejects_missing_fields() -> None:
    client = TestClient(create_app())
    res = client.post('/v1/chat/turn', json={'workspace_id': 'ws-1'})
    assert res.status_code == 422
