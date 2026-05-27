"""Test endpoint POST /v1/chat/turn/stream — 202 + publication NATS asynchrone."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_core.http import create_app


class _StubOrchestrator:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def turn_stream(self, input: Any, *, message_id: str) -> None:
        self.calls.append({'chat_id': input.chat_id, 'message_id': message_id})


@pytest.mark.asyncio
async def test_post_turn_stream_returns_202_immediately() -> None:
    orch = _StubOrchestrator()
    app = create_app(orchestrator=orch)  # type: ignore[arg-type]
    with TestClient(app) as c:
        resp = c.post('/v1/chat/turn/stream', json={
            'conversationId': 'c1', 'workspaceId': 'w', 'userId': 'u',
            'messageId': 'm1', 'model': 'mistral-7b-instruct-q4',
            'history': [{'role': 'user', 'content': 'hello'}],
        })
        assert resp.status_code == 202
    # Laisser le background task tourner.
    await asyncio.sleep(0.05)
    assert orch.calls and orch.calls[0]['message_id'] == 'm1'


def test_post_turn_stream_returns_422_when_no_user_message() -> None:
    orch = _StubOrchestrator()
    app = create_app(orchestrator=orch)  # type: ignore[arg-type]
    with TestClient(app) as c:
        resp = c.post('/v1/chat/turn/stream', json={
            'conversationId': 'c1', 'workspaceId': 'w', 'userId': 'u',
            'messageId': 'm1', 'model': 'm',
            'history': [{'role': 'assistant', 'content': 'previous reply'}],
        })
    assert resp.status_code == 422


def test_post_turn_stream_returns_503_when_no_orchestrator() -> None:
    app = create_app(orchestrator=None)
    with TestClient(app) as c:
        resp = c.post('/v1/chat/turn/stream', json={
            'conversationId': 'c1', 'workspaceId': 'w', 'userId': 'u',
            'messageId': 'm1', 'model': 'm',
            'history': [{'role': 'user', 'content': 'hi'}],
        })
    assert resp.status_code == 503
