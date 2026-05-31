"""Tests d'invariants InferenceClient — finish_reason map, payload, URL.

Couvre les invariants qui ne sont pas dans test_inference_client.py :

  - _FINISH_REASON_MAP : content_filter → 'error' (sécurité : si le modèle
    refuse de répondre pour raisons de safety, on traite ça comme une
    erreur, pas comme un 'stop' silencieux qui masquerait le refus).
    function_call → 'tool_call' (alias historique OpenAI).
    Inconnu → 'stop' (safe default, mais doit être documenté par test).

  - Payload non-stream : stream=false. Sinon on parse une réponse stream
    comme une réponse non-stream et on prend une chaîne {"choices":...}
    qui ressemble à du SSE.

  - max_tokens : présent SEULEMENT si fourni. Si on l'envoie toujours
    avec None, l'OpenAI proxy peut renvoyer 400 selon la version.

  - temperature par défaut = 0.7 (verrouille le contrat ; un changement
    de défaut change la créativité perçue de toutes les réponses).

  - base_url rstrip : un endpoint qui se termine par "/v1/" produit
    "/v1//chat/completions" sans rstrip — 404 selon le proxy.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from ai_core.inference import InferenceClient, InferenceError
from ai_core.inference.client import ChatMessage


def _client_with(handler: Any, *, base_url: str = 'http://router.test/v1') -> InferenceClient:
    transport = httpx.MockTransport(handler)
    return InferenceClient(
        base_url=base_url,
        api_key='test',
        client=httpx.AsyncClient(transport=transport),
    )


def _completion_handler(captured: dict[str, Any], finish_reason: str = 'stop'):
    def handler(req: httpx.Request) -> httpx.Response:
        captured['url'] = str(req.url)
        captured['body'] = json.loads(req.content)
        return httpx.Response(
            200,
            json={
                'model': 'm',
                'choices': [
                    {'message': {'content': 'hi'}, 'finish_reason': finish_reason},
                ],
            },
        )
    return handler


class TestFinishReasonMap:
    """Le map normalise les conventions OpenAI vers notre Literal interne."""

    async def test_stop_passes_through(self) -> None:
        out = await _client_with(_completion_handler({}, 'stop')).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert out.finish_reason == 'stop'

    async def test_length_passes_through(self) -> None:
        out = await _client_with(_completion_handler({}, 'length')).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert out.finish_reason == 'length'

    async def test_function_call_is_aliased_to_tool_call(self) -> None:
        # OpenAI legacy : 'function_call' avant qu'ils renomment en 'tool_calls'.
        # Doit être normalisé pareil sinon les workers tool ne reçoivent pas
        # le signal de déclencher l'exécution d'outil.
        out = await _client_with(_completion_handler({}, 'function_call')).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert out.finish_reason == 'tool_call'

    async def test_content_filter_maps_to_error_NOT_stop(self) -> None:
        # CRITIQUE pour la safety : content_filter signifie que le modèle
        # a REFUSÉ de répondre. Si on mappait à 'stop', le frontend
        # afficherait un message vide comme s'il n'y avait pas de problème.
        out = await _client_with(_completion_handler({}, 'content_filter')).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert out.finish_reason == 'error'
        assert out.finish_reason != 'stop'

    async def test_unknown_reason_defaults_to_stop(self) -> None:
        # Safe default : nouveaux providers peuvent introduire de nouveaux
        # reasons. On préfère 'stop' silencieux à un crash de parse.
        out = await _client_with(_completion_handler({}, 'gpt_5_thinking')).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert out.finish_reason == 'stop'

    async def test_missing_finish_reason_defaults_to_stop(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                'model': 'm',
                'choices': [{'message': {'content': 'hi'}}],  # pas de finish_reason
            })
        out = await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])
        assert out.finish_reason == 'stop'


class TestPayloadShape:
    async def test_chat_sends_stream_false(self) -> None:
        # Sans ça, certains proxies renvoient un SSE qu'on ne peut pas
        # parser en JSON et la requête plante en json.JSONDecodeError.
        captured: dict[str, Any] = {}
        await _client_with(_completion_handler(captured)).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert captured['body']['stream'] is False

    async def test_chat_default_temperature_is_07(self) -> None:
        # Verrouille la créativité par défaut. 0.7 est un compromis
        # OpenAI-style ; le changer modifie la perception qualité.
        captured: dict[str, Any] = {}
        await _client_with(_completion_handler(captured)).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert captured['body']['temperature'] == 0.7

    async def test_chat_omits_max_tokens_when_none(self) -> None:
        # Certains proxies (Ollama notamment) renvoient 400 si max_tokens
        # est null. On ne l'envoie que si demandé explicitement.
        captured: dict[str, Any] = {}
        await _client_with(_completion_handler(captured)).chat(
            model='m', messages=[ChatMessage('user', 'x')]
        )
        assert 'max_tokens' not in captured['body']

    async def test_chat_includes_max_tokens_when_provided(self) -> None:
        captured: dict[str, Any] = {}
        await _client_with(_completion_handler(captured)).chat(
            model='m', messages=[ChatMessage('user', 'x')], max_tokens=512,
        )
        assert captured['body']['max_tokens'] == 512

    async def test_chat_serializes_messages_with_role_and_content(self) -> None:
        # Le format wire attendu par l'API OpenAI : [{role, content}].
        # Un sérialiseur naïf qui passerait la dataclass dict() avec
        # d'autres champs casserait certains proxies stricts.
        captured: dict[str, Any] = {}
        await _client_with(_completion_handler(captured)).chat(
            model='m',
            messages=[
                ChatMessage(role='system', content='S'),
                ChatMessage(role='user', content='U'),
            ],
        )
        assert captured['body']['messages'] == [
            {'role': 'system', 'content': 'S'},
            {'role': 'user', 'content': 'U'},
        ]


class TestUrlNormalization:
    async def test_base_url_trailing_slash_is_stripped(self) -> None:
        # Sans rstrip, on aurait `/v1//chat/completions` (404 fréquent).
        captured: dict[str, Any] = {}
        client = _client_with(_completion_handler(captured), base_url='http://router.test/v1/')
        await client.chat(model='m', messages=[ChatMessage('user', 'x')])
        assert captured['url'] == 'http://router.test/v1/chat/completions'

    async def test_base_url_without_slash_works(self) -> None:
        captured: dict[str, Any] = {}
        client = _client_with(_completion_handler(captured), base_url='http://router.test/v1')
        await client.chat(model='m', messages=[ChatMessage('user', 'x')])
        assert captured['url'] == 'http://router.test/v1/chat/completions'


class TestResponseParsing:
    async def test_text_falls_back_to_empty_when_content_is_null(self) -> None:
        # Certains proxies renvoient content=null sur un finish_reason='length'
        # mid-token. Le client doit donner '' au lieu de None pour ne pas
        # propager None dans le TurnOutput.text (front affiche "null").
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                'model': 'm',
                'choices': [{'message': {'content': None}, 'finish_reason': 'length'}],
            })
        out = await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])
        assert out.text == ''
        assert isinstance(out.text, str)

    async def test_model_from_response_overrides_requested_model(self) -> None:
        # Si le router substitue le modèle (fallback Mistral → llama p.ex.),
        # on veut savoir quel modèle a effectivement répondu pour la
        # facturation et les logs.
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                'model': 'llama-3.3-fallback',
                'choices': [{'message': {'content': 'hi'}, 'finish_reason': 'stop'}],
            })
        out = await _client_with(handler).chat(
            model='mistral-large', messages=[ChatMessage('user', 'x')]
        )
        assert out.model == 'llama-3.3-fallback'

    async def test_5xx_error_message_is_truncated_to_200_chars(self) -> None:
        # Anti-leak / anti-flood logs : un body 5xx peut être énorme (HTML).
        # On ne laisse fuiter que 200 chars dans l'InferenceError.
        huge = 'X' * 5000
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text=huge)
        with pytest.raises(InferenceError) as ei:
            await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])
        # Message format: "inference-router 500: XXXX...". On compte les X.
        msg = str(ei.value)
        assert msg.count('X') == 200
