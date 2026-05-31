"""Caractérisation Orchestrator.turn_stream — invariants subtils.

test_orchestrator_stream.py couvre 3 happy paths (forward tokens+done,
emit error, silent end → done). Ce fichier verrouille les invariants
plus fins du fan-out vers EventPublisher.

  - **delta vide/None non-forwardé** : `if evt.type == 'token' and evt.delta:`
    filtre les tokens dont le delta est '' ou None. Sinon le frontend
    reçoit des publish vides et fait flicker. Symétrique au filter
    fait côté chat_stream du client InferenceClient.

  - **error event SHORT-CIRCUITS** : à la réception d'un StreamEvent
    type='error', l'orchestrateur publie .error() et `return` IMMÉDIAT.
    Aucun .done() n'est publié après. Sinon le frontend croit que le
    stream s'est terminé OK alors qu'il a échoué.

  - **tokens_in heuristique = (system + user content) // 4** : le
    publisher.done reçoit un tokens_in calculé sur la SOMME des content
    de TOUS les messages (system prompt INCLUS), divisée par 4. C'est
    une heuristique grossière utilisée pour le billing — si on excluait
    le system prompt, on sous-facturerait. Si on changeait //4, les
    coûts unitaires changeraient sans ADR.

  - **tokens_out heuristique = sum(delta lens) // 4** : accumulé sur
    les events token forwardés (donc skip les deltas vides). Cohérent
    avec tokens_in côté unité.

  - **done sans finish_reason → 'stop'** : `evt.finish_reason or 'stop'`
    safe default. Sinon publish.done(finish_reason=None) côté webhook.

  - **conversation_id == input.chat_id** : pas workspace_id ni user_id.
    Critique pour le routage SSE côté realtime (subscribers écoutent
    par chat_id).

  - **System prompt prepend identique à turn()** : même contenu, même
    ordre. Garantit que le streaming et le non-stream produisent des
    résultats comparables pour le même input.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from ai_core.inference import ChatMessage, StreamEvent
from ai_core.orchestrator.loop import Orchestrator, TurnInput


class _RecordingInference:
    """Capture chat_stream kwargs ET yield les events fournis."""

    def __init__(self, events: list[StreamEvent]) -> None:
        self._events = events
        self.last_kwargs: dict[str, Any] = {}

    async def chat_stream(self, **kw: Any) -> AsyncIterator[StreamEvent]:
        self.last_kwargs = kw
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


def _make(events: list[StreamEvent]) -> tuple[Orchestrator, _FakePublisher, _RecordingInference]:
    inference = _RecordingInference(events)
    pub = _FakePublisher()
    orch = Orchestrator(inference=inference, publisher=pub)  # type: ignore[arg-type]
    return orch, pub, inference


async def _run(orch: Orchestrator, *, chat_id: str = 'c1', message: str = 'hi') -> None:
    await orch.turn_stream(
        TurnInput(workspace_id='w', user_id='u', chat_id=chat_id, message=message),
        message_id='m1',
    )


class TestEmptyDeltaFiltering:
    """delta '' ou None → pas de publish.token (anti-flicker)."""

    @pytest.mark.asyncio
    async def test_empty_string_delta_not_forwarded(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='token', delta=''),
            StreamEvent(type='token', delta='real'),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        token_calls = [c for c in pub.calls if c[0] == 'token']
        assert len(token_calls) == 1
        assert token_calls[0][1]['delta'] == 'real'

    @pytest.mark.asyncio
    async def test_none_delta_not_forwarded(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='token', delta=None),
            StreamEvent(type='token', delta='x'),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        token_calls = [c for c in pub.calls if c[0] == 'token']
        assert len(token_calls) == 1


class TestErrorShortCircuit:
    """type='error' → publish.error puis RETURN — pas de done après."""

    @pytest.mark.asyncio
    async def test_error_blocks_subsequent_done_publication(self) -> None:
        # Même si on yield un 'done' APRÈS l'error, l'orchestrateur ne le
        # voit pas car il a déjà return.
        orch, pub, _ = _make([
            StreamEvent(type='token', delta='partial'),
            StreamEvent(type='error', error='backend_died'),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        types = [c[0] for c in pub.calls]
        # Exactement : token, error. PAS de done à la fin.
        assert types == ['token', 'error']
        assert 'done' not in types

    @pytest.mark.asyncio
    async def test_error_alone_yields_only_error(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='error', error='boom'),
        ])
        await _run(orch)
        assert [c[0] for c in pub.calls] == ['error']

    @pytest.mark.asyncio
    async def test_error_reason_default_unknown_when_none(self) -> None:
        # `evt.error or 'unknown'` — si le client ne fournit pas de reason,
        # on ne publie pas reason=None mais 'unknown'.
        orch, pub, _ = _make([
            StreamEvent(type='error', error=None),
        ])
        await _run(orch)
        error_call = pub.calls[0]
        assert error_call[0] == 'error'
        assert error_call[1]['reason'] == 'unknown'


class TestTokensInHeuristic:
    """tokens_in = sum(len(content) for m in messages) // 4 — SYSTEM INCLUS."""

    @pytest.mark.asyncio
    async def test_tokens_in_includes_system_prompt(self) -> None:
        # Le system prompt est environ 130 chars. Avec un message user
        # de 1 char, tokens_in doit être ~32 (130//4), PAS 0 (1//4).
        orch, pub, _ = _make([StreamEvent(type='done', finish_reason='stop')])
        await _run(orch, message='x')
        done = pub.calls[-1]
        assert done[0] == 'done'
        # tokens_in >> 1, prouve que system prompt est compté.
        assert done[1]['tokens_in'] >= 20

    @pytest.mark.asyncio
    async def test_tokens_in_grows_with_user_message_length(self) -> None:
        orch_short, pub_short, _ = _make([StreamEvent(type='done', finish_reason='stop')])
        await _run(orch_short, message='a')
        short_tokens = pub_short.calls[-1][1]['tokens_in']

        orch_long, pub_long, _ = _make([StreamEvent(type='done', finish_reason='stop')])
        await _run(orch_long, message='a' * 400)
        long_tokens = pub_long.calls[-1][1]['tokens_in']

        # 400 chars de plus → ~100 tokens de plus (//4).
        assert long_tokens - short_tokens >= 90

    @pytest.mark.asyncio
    async def test_tokens_in_uses_integer_division_by_4(self) -> None:
        # tokens_in toujours int, jamais float.
        orch, pub, _ = _make([StreamEvent(type='done', finish_reason='stop')])
        await _run(orch, message='hi')
        assert isinstance(pub.calls[-1][1]['tokens_in'], int)


class TestTokensOutHeuristic:
    """tokens_out = (sum of delta chars accumulés) // 4."""

    @pytest.mark.asyncio
    async def test_tokens_out_counts_only_non_empty_deltas(self) -> None:
        # Empty deltas filtered AVANT le compteur — out_chars n'inclut PAS
        # les '' ni les None.
        orch, pub, _ = _make([
            StreamEvent(type='token', delta=''),
            StreamEvent(type='token', delta='a' * 40),
            StreamEvent(type='token', delta=None),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        done = pub.calls[-1]
        # 40 chars // 4 = 10
        assert done[1]['tokens_out'] == 10

    @pytest.mark.asyncio
    async def test_tokens_out_zero_when_no_token_events(self) -> None:
        orch, pub, _ = _make([StreamEvent(type='done', finish_reason='stop')])
        await _run(orch)
        assert pub.calls[-1][1]['tokens_out'] == 0

    @pytest.mark.asyncio
    async def test_tokens_out_uses_integer_division(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='token', delta='abc'),  # 3 chars
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        # 3 // 4 = 0 — pas 0.75
        assert pub.calls[-1][1]['tokens_out'] == 0
        assert isinstance(pub.calls[-1][1]['tokens_out'], int)


class TestDoneFinishReasonDefault:
    """done sans finish_reason → 'stop'."""

    @pytest.mark.asyncio
    async def test_done_with_none_finish_reason_defaults_to_stop(self) -> None:
        # Un done event peut arriver avec finish_reason=None (parser SSE
        # n'a pas eu de champ). On publie 'stop' au lieu de None.
        orch, pub, _ = _make([
            StreamEvent(type='done', finish_reason=None),
        ])
        await _run(orch)
        assert pub.calls[-1][1]['finish_reason'] == 'stop'

    @pytest.mark.asyncio
    async def test_done_with_length_propagated(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='done', finish_reason='length'),
        ])
        await _run(orch)
        assert pub.calls[-1][1]['finish_reason'] == 'length'

    @pytest.mark.asyncio
    async def test_silent_end_defaults_finish_reason_stop(self) -> None:
        # Aucun event done dans le stream : la valeur initiale 'stop'
        # est utilisée dans le final publish.done().
        orch, pub, _ = _make([
            StreamEvent(type='token', delta='x'),
        ])
        await _run(orch)
        assert pub.calls[-1][0] == 'done'
        assert pub.calls[-1][1]['finish_reason'] == 'stop'


class TestConversationIdRouting:
    """Tous les publish utilisent conversation_id = input.chat_id."""

    @pytest.mark.asyncio
    async def test_token_publish_uses_chat_id(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='token', delta='a'),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch, chat_id='chat-uuid-42')
        token_call = next(c for c in pub.calls if c[0] == 'token')
        assert token_call[1]['conversation_id'] == 'chat-uuid-42'

    @pytest.mark.asyncio
    async def test_done_publish_uses_chat_id(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch, chat_id='chat-uuid-99')
        done_call = pub.calls[-1]
        assert done_call[1]['conversation_id'] == 'chat-uuid-99'

    @pytest.mark.asyncio
    async def test_error_publish_uses_chat_id(self) -> None:
        orch, pub, _ = _make([
            StreamEvent(type='error', error='boom'),
        ])
        await _run(orch, chat_id='chat-uuid-77')
        assert pub.calls[0][1]['conversation_id'] == 'chat-uuid-77'

    @pytest.mark.asyncio
    async def test_message_id_propagated_to_all_publishes(self) -> None:
        # Même invariant pour message_id.
        orch, pub, _ = _make([
            StreamEvent(type='token', delta='a'),
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        for _kind, kw in pub.calls:
            assert kw['message_id'] == 'm1'


class TestStreamMessageShape:
    """Le chat_stream reçoit system + user, dans cet ordre, role correct."""

    @pytest.mark.asyncio
    async def test_first_message_is_system_role(self) -> None:
        orch, _, inf = _make([
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch, message='question')
        messages: list[ChatMessage] = inf.last_kwargs['messages']
        assert messages[0].role == 'system'

    @pytest.mark.asyncio
    async def test_second_message_is_user_with_input_text(self) -> None:
        orch, _, inf = _make([
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch, message='ma question')
        messages: list[ChatMessage] = inf.last_kwargs['messages']
        assert messages[1].role == 'user'
        assert messages[1].content == 'ma question'

    @pytest.mark.asyncio
    async def test_exactly_two_messages_sent(self) -> None:
        # Pas de history en Jour-1 : strict system+user, rien d'autre.
        orch, _, inf = _make([
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        assert len(inf.last_kwargs['messages']) == 2

    @pytest.mark.asyncio
    async def test_system_prompt_mentions_claudemaison(self) -> None:
        # Parallèle au test équivalent pour turn() : marque d'identité.
        orch, _, inf = _make([
            StreamEvent(type='done', finish_reason='stop'),
        ])
        await _run(orch)
        system_msg: ChatMessage = inf.last_kwargs['messages'][0]
        assert 'ClaudeMaison' in system_msg.content
