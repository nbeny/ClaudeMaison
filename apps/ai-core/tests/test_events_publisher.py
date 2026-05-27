"""Tests EventPublisher — payload, sujet."""

from __future__ import annotations

import json
from typing import Any

from ai_core.events import EventPublisher


class _RecordingNats:
    """Faux client NATS qui enregistre les publish."""

    def __init__(self) -> None:
        self.published: list[tuple[str, bytes]] = []

    async def publish(self, subject: str, data: bytes) -> None:
        self.published.append((subject, data))

    async def drain(self) -> None: ...


async def test_publish_token_serializes_payload() -> None:
    nc = _RecordingNats()
    pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
    await pub.token(conversation_id='c1', message_id='m1', delta='Hi')
    assert len(nc.published) == 1
    subj, data = nc.published[0]
    assert subj == 'events.c1'
    payload: dict[str, Any] = json.loads(data)
    assert payload == {'type': 'token', 'messageId': 'm1', 'delta': 'Hi'}


async def test_publish_done_includes_finish_reason() -> None:
    nc = _RecordingNats()
    pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
    await pub.done(
        conversation_id='c1',
        message_id='m1',
        finish_reason='stop',
        tokens_in=10,
        tokens_out=3,
    )
    payload: dict[str, Any] = json.loads(nc.published[0][1])
    assert payload == {
        'type': 'done',
        'messageId': 'm1',
        'finishReason': 'stop',
        'tokensIn': 10,
        'tokensOut': 3,
    }


async def test_publish_error_serializes_reason() -> None:
    nc = _RecordingNats()
    pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
    await pub.error(conversation_id='c1', message_id='m1', reason='all_backends_failed')
    subj, data = nc.published[0]
    assert subj == 'events.c1'
    payload: dict[str, Any] = json.loads(data)
    assert payload == {'type': 'error', 'messageId': 'm1', 'reason': 'all_backends_failed'}
