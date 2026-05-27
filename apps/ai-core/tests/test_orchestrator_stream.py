"""Tests Orchestrator.turn_stream — flux InferenceClient → EventPublisher."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from ai_core.inference import ChatMessage, StreamEvent
from ai_core.orchestrator.loop import Orchestrator, TurnInput


class _FakeInference:
    def __init__(self, events: list[StreamEvent]) -> None:
        self._events = events

    async def chat_stream(self, **_: Any) -> AsyncIterator[StreamEvent]:
        for evt in self._events:
            yield evt

    async def aclose(self) -> None: ...


class _FakePublisher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def token(self, **kw: Any) -> None:
        self.calls.append(('token', kw))

    async def done(self, **kw: Any) -> None:
        self.calls.append(('done', kw))

    async def error(self, **kw: Any) -> None:
        self.calls.append(('error', kw))


@pytest.mark.asyncio
async def test_turn_stream_forwards_tokens_and_done() -> None:
    inference = _FakeInference([
        StreamEvent(type='token', delta='Hi'),
        StreamEvent(type='token', delta='!'),
        StreamEvent(type='done', finish_reason='stop'),
    ])
    pub = _FakePublisher()
    orch = Orchestrator(inference=inference, publisher=pub)  # type: ignore[arg-type]
    await orch.turn_stream(TurnInput(
        workspace_id='w', user_id='u', chat_id='c1', message='hi',
    ), message_id='m1')
    types = [c[0] for c in pub.calls]
    assert types == ['token', 'token', 'done']
    assert pub.calls[0][1]['delta'] == 'Hi'
    assert pub.calls[-1][1]['finish_reason'] == 'stop'


@pytest.mark.asyncio
async def test_turn_stream_emits_error_on_stream_error() -> None:
    inference = _FakeInference([
        StreamEvent(type='error', error='all_backends_failed'),
    ])
    pub = _FakePublisher()
    orch = Orchestrator(inference=inference, publisher=pub)  # type: ignore[arg-type]
    await orch.turn_stream(TurnInput(
        workspace_id='w', user_id='u', chat_id='c1', message='hi',
    ), message_id='m1')
    assert pub.calls[-1][0] == 'error'
    assert pub.calls[-1][1]['reason'] == 'all_backends_failed'
