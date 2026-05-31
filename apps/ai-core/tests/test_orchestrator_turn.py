"""Tests Orchestrator.turn (non-stream) + emit_error.

Le path stream est déjà couvert par test_orchestrator_stream.py. Ce fichier
verrouille la surface non-stream et les invariants partagés :

  - Le SYSTEM_PROMPT est TOUJOURS prepended (sécurité d'identité du modèle).
    Une régression qui le drop ferait répondre Mistral comme un assistant
    générique sans identité ClaudeMaison.

  - Sur InferenceError, turn() ne RE-throw PAS — elle renvoie un TurnOutput
    avec finish_reason='error' et un texte de fallback. Re-throw ferait
    crasher la route HTTP avec 500 au lieu d'un 200 + message d'erreur
    utilisateur compréhensible.

  - Le model par défaut vient de LLM_DEFAULT_MODEL (config). Si on hardcodait
    un model spécifique, le switch de modèle via env serait silencieusement
    ignoré.

  - emit_error est tolérant à publisher=None (no-op). turn_stream lui exige
    un publisher (raise) parce qu'il ne peut pas streamer sans.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from ai_core.inference import ChatCompletion, ChatMessage, InferenceError, StreamEvent
from ai_core.orchestrator.loop import Orchestrator, TurnInput


class _FakeInference:
    """Enregistre les appels chat() pour inspection."""

    def __init__(self, completion: ChatCompletion | None = None,
                 error: InferenceError | None = None) -> None:
        self._completion = completion
        self._error = error
        self.chat_calls: list[dict[str, Any]] = []

    async def chat(self, **kw: Any) -> ChatCompletion:
        self.chat_calls.append(kw)
        if self._error is not None:
            raise self._error
        assert self._completion is not None
        return self._completion

    async def chat_stream(self, **_: Any) -> AsyncIterator[StreamEvent]:
        yield StreamEvent(type='done', finish_reason='stop')

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


def _completion(text: str = 'Salut !', model: str = 'mistral-large-instruct') -> ChatCompletion:
    return ChatCompletion(text=text, finish_reason='stop', model=model, raw={})


@pytest.mark.asyncio
class TestTurnHappyPath:
    async def test_passes_through_inference_text(self) -> None:
        inf = _FakeInference(completion=_completion(text='Bonjour Daisy.'))
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        out = await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        assert out.text == 'Bonjour Daisy.'
        assert out.chat_id == 'c1'
        assert out.finish_reason == 'stop'

    async def test_uses_input_model_when_provided(self) -> None:
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
            model='mistral-small',
        ))

        assert inf.chat_calls[0]['model'] == 'mistral-small'

    async def test_falls_back_to_LLM_DEFAULT_MODEL_when_input_model_none(self) -> None:
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi', model=None,
        ))

        # Le default vient de settings.LLM_DEFAULT_MODEL — on n'asserte pas
        # une valeur précise (ça appartient à config.py) mais on vérifie
        # qu'il est non-vide.
        assert inf.chat_calls[0]['model']
        assert isinstance(inf.chat_calls[0]['model'], str)


@pytest.mark.asyncio
class TestTurnSystemPrompt:
    """Le system prompt définit l'identité ClaudeMaison — il doit TOUJOURS
    être présent en première position. Sans lui, le modèle répond comme un
    assistant générique."""

    async def test_prepends_system_role_first(self) -> None:
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        messages: list[ChatMessage] = inf.chat_calls[0]['messages']
        assert messages[0].role == 'system'

    async def test_system_prompt_mentions_ClaudeMaison(self) -> None:
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        messages: list[ChatMessage] = inf.chat_calls[0]['messages']
        # Verrouille l'identité produit. Une régression vers
        # "You are a helpful assistant" ferait perdre le branding et
        # la mention de la souveraineté EU.
        assert 'ClaudeMaison' in messages[0].content

    async def test_user_message_appended_after_system(self) -> None:
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='Quelle heure est-il ?',
        ))

        messages: list[ChatMessage] = inf.chat_calls[0]['messages']
        assert len(messages) == 2
        assert messages[1].role == 'user'
        assert messages[1].content == 'Quelle heure est-il ?'


@pytest.mark.asyncio
class TestTurnInferenceErrorHandling:
    """InferenceError doit être ABSORBÉE par turn() — pas de re-throw."""

    async def test_does_not_raise_on_inference_error(self) -> None:
        inf = _FakeInference(error=InferenceError('upstream 503', status=503))
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        # Si ça raise, c'est une régression critique : la route HTTP renverra
        # 500 au lieu d'un payload d'erreur utilisable côté UI.
        out = await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        assert out is not None

    async def test_returns_finish_reason_error(self) -> None:
        inf = _FakeInference(error=InferenceError('boom', status=502))
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        out = await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        assert out.finish_reason == 'error'

    async def test_returns_fallback_text_in_french(self) -> None:
        # Le texte est visible utilisateur — verrouillé en français pour
        # éviter une régression EN qui briserait l'UX FR.
        inf = _FakeInference(error=InferenceError('boom'))
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        out = await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='c1', message='hi',
        ))

        assert 'Désolé' in out.text
        # Ne doit PAS leak le message d'erreur interne (sécurité).
        assert 'boom' not in out.text

    async def test_preserves_chat_id_on_error(self) -> None:
        inf = _FakeInference(error=InferenceError('boom'))
        orch = Orchestrator(inference=inf)  # type: ignore[arg-type]

        out = await orch.turn(TurnInput(
            workspace_id='w', user_id='u', chat_id='chat-42', message='hi',
        ))

        assert out.chat_id == 'chat-42'


@pytest.mark.asyncio
class TestEmitError:
    async def test_publisher_called_with_correct_fields(self) -> None:
        inf = _FakeInference(completion=_completion())
        pub = _FakePublisher()
        orch = Orchestrator(inference=inf, publisher=pub)  # type: ignore[arg-type]

        await orch.emit_error(conversation_id='c1', message_id='m1', reason='quota_exhausted')

        assert pub.calls == [('error', {
            'conversation_id': 'c1', 'message_id': 'm1', 'reason': 'quota_exhausted',
        })]

    async def test_silent_noop_when_publisher_is_none(self) -> None:
        # Contrat : emit_error ne raise PAS si publisher absent. Le caller
        # appelle souvent dans un except, ne doit pas paniquer.
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf, publisher=None)  # type: ignore[arg-type]

        await orch.emit_error(conversation_id='c1', message_id='m1', reason='x')
        # pas d'exception = succès


@pytest.mark.asyncio
class TestTurnStreamRequiresPublisher:
    async def test_raises_when_publisher_none(self) -> None:
        # Différent d'emit_error : turn_stream NE PEUT PAS marcher sans
        # publisher (c'est sa raison d'être), donc on raise fort.
        inf = _FakeInference(completion=_completion())
        orch = Orchestrator(inference=inf, publisher=None)  # type: ignore[arg-type]

        with pytest.raises(RuntimeError, match='[Pp]ublisher'):
            await orch.turn_stream(
                TurnInput(workspace_id='w', user_id='u', chat_id='c1', message='hi'),
                message_id='m1',
            )
