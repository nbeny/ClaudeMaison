"""Tests d'invariants HTTP — pivot user message + _run_stream error guard.

Couvre des invariants subtils non couverts par test_http.py et
test_http_turn_stream.py :

  - Le "user pivot" : POST /turn/stream prend le DERNIER user message
    dans `history` (reversed), pas le premier. Important parce que
    l'history peut commencer par un system prompt côté UI, puis user,
    puis assistant, puis user (current) — c'est ce dernier user qui
    doit servir de prompt.

  - `_run_stream` est un wrapper qui ENTOURE turn_stream d'un try/except.
    Si l'orchestrator raise (ex: NATS down après start), on ne doit pas
    laisser la coroutine pendre silencieusement — on émet un event
    'error' côté NATS pour que le client SSE reçoive un signal.

  - L'erreur interne ne fuite PAS dans le payload HTTP 202 (le payload
    est figé à {status: accepted}).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_core.http import create_app


class _Spy:
    """Espion turn_stream + emit_error pour observer la propagation d'erreur."""

    def __init__(self, raise_on_turn: Exception | None = None,
                 raise_on_emit: Exception | None = None) -> None:
        self._raise_on_turn = raise_on_turn
        self._raise_on_emit = raise_on_emit
        self.turn_calls: list[dict[str, Any]] = []
        self.emit_calls: list[dict[str, Any]] = []

    async def turn_stream(self, input: Any, *, message_id: str) -> None:
        self.turn_calls.append({
            'chat_id': input.chat_id,
            'message': input.message,
            'workspace_id': input.workspace_id,
            'user_id': input.user_id,
            'model': input.model,
            'message_id': message_id,
        })
        if self._raise_on_turn is not None:
            raise self._raise_on_turn

    async def emit_error(self, *, conversation_id: str, message_id: str, reason: str) -> None:
        self.emit_calls.append({
            'conversation_id': conversation_id,
            'message_id': message_id,
            'reason': reason,
        })
        if self._raise_on_emit is not None:
            raise self._raise_on_emit


def _post_stream(client: TestClient, history: list[dict[str, str]],
                 *, conversation_id: str = 'c1', message_id: str = 'm1') -> Any:
    return client.post('/v1/chat/turn/stream', json={
        'conversationId': conversation_id, 'workspaceId': 'w', 'userId': 'u',
        'messageId': message_id, 'model': 'mistral',
        'history': history,
    })


class TestUserMessagePivot:
    """Le dernier user message de l'history est le prompt actif."""

    @pytest.mark.asyncio
    async def test_picks_last_user_message_in_mixed_history(self) -> None:
        spy = _Spy()
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [
                {'role': 'system', 'content': 'tu es un assistant'},
                {'role': 'user', 'content': 'PREMIER message'},
                {'role': 'assistant', 'content': 'PREMIÈRE réponse'},
                {'role': 'user', 'content': 'DERNIER message'},
            ])
            assert resp.status_code == 202

        await asyncio.sleep(0.05)
        assert len(spy.turn_calls) == 1
        # CRITIQUE : c'est le dernier user qui sert de prompt, pas le premier.
        assert spy.turn_calls[0]['message'] == 'DERNIER message'

    @pytest.mark.asyncio
    async def test_picks_user_message_when_assistant_is_last(self) -> None:
        # Cas où la dernière ligne est assistant (history rejouée).
        # On doit retourner en arrière pour trouver le dernier user.
        spy = _Spy()
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [
                {'role': 'user', 'content': 'Q1'},
                {'role': 'assistant', 'content': 'A1'},
                {'role': 'user', 'content': 'Q2'},
                {'role': 'assistant', 'content': 'A2'},
            ])
            # Ici Q2 est le dernier user message.
            assert resp.status_code == 202

        await asyncio.sleep(0.05)
        assert spy.turn_calls[0]['message'] == 'Q2'

    def test_returns_422_when_only_system_and_assistant_messages(self) -> None:
        # Pas de user message du tout → 422.
        spy = _Spy()
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [
                {'role': 'system', 'content': 'sys'},
                {'role': 'assistant', 'content': 'assistant only'},
            ])
            assert resp.status_code == 422
            # Le payload d'erreur ne doit pas faire crasher le format JSON
            assert 'detail' in resp.json()

    def test_returns_422_on_empty_history(self) -> None:
        spy = _Spy()
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [])
            assert resp.status_code == 422


class TestRunStreamErrorGuard:
    """_run_stream catch les exceptions de turn_stream pour émettre un
    event 'error' côté NATS — sinon le client SSE pendrait sans signal."""

    @pytest.mark.asyncio
    async def test_emit_error_is_called_when_turn_stream_raises(self) -> None:
        spy = _Spy(raise_on_turn=RuntimeError('NATS down mid-stream'))
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [{'role': 'user', 'content': 'hi'}],
                                conversation_id='C-42', message_id='M-42')
            # 202 est renvoyé IMMÉDIATEMENT (background task) — même si turn_stream
            # va planter ensuite.
            assert resp.status_code == 202

        # Laisser tourner le bg task qui doit appeler emit_error
        await asyncio.sleep(0.05)
        assert len(spy.emit_calls) == 1
        assert spy.emit_calls[0]['conversation_id'] == 'C-42'
        assert spy.emit_calls[0]['message_id'] == 'M-42'
        # Le reason est figé 'internal_error' (PAS le str(exc) brut qui leakerait
        # NATS internals dans le payload SSE final).
        assert spy.emit_calls[0]['reason'] == 'internal_error'
        assert 'NATS' not in spy.emit_calls[0]['reason']

    @pytest.mark.asyncio
    async def test_emit_error_failure_does_not_crash_background_task(self) -> None:
        # Cas pathologique : turn_stream raise ET emit_error raise. Le bg
        # task ne doit pas propager une exception non-catchée (sinon le
        # serveur peut tomber selon la config ASGI).
        spy = _Spy(
            raise_on_turn=RuntimeError('inference down'),
            raise_on_emit=RuntimeError('NATS also down'),
        )
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [{'role': 'user', 'content': 'hi'}])
            assert resp.status_code == 202

        # Si le bg task crashait, on aurait un warning unhandled task
        # exception. Le test passe simplement en vérifiant qu'on a tenté
        # d'appeler emit_error (même si c'est en vain).
        await asyncio.sleep(0.05)
        assert len(spy.emit_calls) == 1


class TestPostTurnStreamPayloadStability:
    @pytest.mark.asyncio
    async def test_202_body_is_status_accepted_regardless_of_background_outcome(self) -> None:
        spy = _Spy(raise_on_turn=RuntimeError('boom'))
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = _post_stream(client, [{'role': 'user', 'content': 'hi'}])
            assert resp.status_code == 202
            # Le body est figé même si le bg task va planter.
            assert resp.json() == {'status': 'accepted'}


class TestHealthShape:
    def test_health_includes_service_name(self) -> None:
        """L'endpoint /health expose le nom du service (utile pour
        l'agrégation multi-service côté monitoring)."""
        spy = _Spy()
        client = TestClient(create_app(orchestrator=spy))  # type: ignore[arg-type]

        with client:
            resp = client.get('/health')

        assert resp.status_code == 200
        body = resp.json()
        assert body['status'] == 'ok'
        assert body['service'] == 'ai-core'
