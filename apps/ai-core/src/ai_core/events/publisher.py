"""Publication d'events de cycle d'inférence sur NATS Core."""

from __future__ import annotations

import json
from typing import Literal, Protocol


class _NatsLike(Protocol):
    async def publish(self, subject: str, data: bytes) -> None: ...
    async def drain(self) -> None: ...


class EventPublisher:
    """Émet des events sur le sujet `events.<conversation_id>`.

    NATS Core best-effort : si aucun realtime n'écoute, le message est perdu.
    OK pour Phase 1 — le message assistant final est persisté côté edge-api.
    """

    def __init__(self, connection: _NatsLike) -> None:
        self._conn = connection

    async def token(self, *, conversation_id: str, message_id: str, delta: str) -> None:
        await self._emit(
            conversation_id,
            {'type': 'token', 'messageId': message_id, 'delta': delta},
        )

    async def done(
        self,
        *,
        conversation_id: str,
        message_id: str,
        finish_reason: Literal['stop', 'length', 'tool_call', 'error'],
        tokens_in: int,
        tokens_out: int,
    ) -> None:
        await self._emit(
            conversation_id,
            {
                'type': 'done',
                'messageId': message_id,
                'finishReason': finish_reason,
                'tokensIn': tokens_in,
                'tokensOut': tokens_out,
            },
        )

    async def error(self, *, conversation_id: str, message_id: str, reason: str) -> None:
        await self._emit(
            conversation_id,
            {'type': 'error', 'messageId': message_id, 'reason': reason},
        )

    async def _emit(self, conversation_id: str, payload: dict[str, object]) -> None:
        subject = f'events.{conversation_id}'
        await self._conn.publish(subject, json.dumps(payload).encode())
