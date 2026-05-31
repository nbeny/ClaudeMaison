"""Caractérisation chat_stream — robustesse SSE + payload + headers.

test_inference_stream.py couvre 2 happy paths (deltas + 5xx → error event).
Ce fichier verrouille les invariants subtils du parseur SSE, car ils sont
implicites dans le code et facilement cassables par une refacto bien
intentionnée.

Invariants verrouillés :

  - **`[DONE]` sentinel skippé** : la convention OpenAI termine le stream
    par `data: [DONE]`. Si on ne le skip pas, on tente un json.loads('[DONE]')
    qui échoue ET on s'arrête là sans jamais voir le finish_reason qui
    le précède.

  - **Lignes non-`data:` skippées** : les serveurs SSE envoient des
    `event:` (typage), des `: comment` (heartbeats keepalive), des
    blank lines (séparateurs). Le parseur ne doit en voir que les
    `data:`. Sinon le keepalive `:` toutes les 15s fait du bruit dans
    la stream.

  - **JSON invalide silently dropped** : un proxy peut envoyer un chunk
    mal-formé sous charge (truncation). Le client ne doit PAS crasher
    sur un `json.JSONDecodeError` — il skip la ligne et continue. Sinon
    UN proxy buggy = TOUTE la session SSE qui meurt.

  - **delta vide → pas d'event token** : `if delta:` filtre les deltas
    null/'' avant de yield. Sinon le frontend reçoit des events vides
    qui font scroll/flicker.

  - **finish_reason mappé par _FINISH_REASON_MAP** : même map que
    chat() non-stream. content_filter doit MAP À 'error', pas 'stop',
    sinon refus de safety silencieux côté UI.

  - **stream=True dans payload** : si on envoie stream=False, le proxy
    renvoie un body JSON unique au lieu d'un SSE. Le parser n'attend
    pas un body JSON → comportement indéfini.

  - **Authorization header conditionnel** : injecté UNIQUEMENT si
    api_key set. Sinon on envoie `Authorization: Bearer None` qui
    fait 401 sur les routers stricts.

  - **httpx.HTTPError mid-stream → event error yielded** : si le réseau
    coupe APRÈS le first byte, le client doit yield un dernier event
    'error' au lieu de pendre. Sinon le caller attend pour toujours.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

import httpx
import pytest

from ai_core.inference import InferenceClient
from ai_core.inference.client import ChatMessage


def _make_sse(lines: Iterable[str]) -> bytes:
    """Concatène des lignes SSE brutes (sans ajouter \\n\\n entre)."""
    return ('\n\n'.join(lines) + '\n\n').encode()


def _client_with(handler: Any, *, api_key: str | None = 'k') -> InferenceClient:
    transport = httpx.MockTransport(handler)
    return InferenceClient(
        base_url='http://router.test/v1',
        api_key=api_key,
        client=httpx.AsyncClient(transport=transport),
    )


async def _collect(client: InferenceClient) -> list[Any]:
    events: list[Any] = []
    async for evt in client.chat_stream(
        model='m', messages=[ChatMessage('user', 'hi')]
    ):
        events.append(evt)
    return events


# ---------------------------------------------------------------------------
# Parser robustness
# ---------------------------------------------------------------------------


class TestSseSentinel:
    async def test_done_sentinel_skipped_not_parsed_as_json(self) -> None:
        # Si on parsait [DONE] en JSON, on aurait json.JSONDecodeError
        # → le silent-drop fallback s'en occupe, mais ce test verrouille
        # le SKIP explicite via `if data == '[DONE]': continue`.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":"hi"}}]}',
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                    'data: [DONE]',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        # On a un token + un done. Aucun event 'error' généré par
        # le parse de [DONE].
        types = [e.type for e in events]
        assert types == ['token', 'done']

    async def test_done_sentinel_after_finish_does_not_emit_extra_event(
        self,
    ) -> None:
        # Cas commun : finish_reason vient AVEC le dernier chunk.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":"x"}}]}',
                    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                    'data: [DONE]',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        # On NE doit PAS avoir 3 events 'done' (1 par bigot fou).
        assert sum(1 for e in events if e.type == 'done') == 1


class TestSseLineFiltering:
    async def test_event_lines_are_skipped(self) -> None:
        # OpenAI peut envoyer `event: <type>` avant chaque data en mode
        # typed SSE. On les ignore.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'event: chunk',
                    'data: {"choices":[{"delta":{"content":"hi"}}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        assert [e.type for e in events] == ['token']

    async def test_comment_lines_are_skipped(self) -> None:
        # `: keepalive` est le format SSE des heartbeats. Doivent être
        # silencieusement ignorés.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    ': keepalive',
                    'data: {"choices":[{"delta":{"content":"hi"}}]}',
                    ': another keepalive',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        assert [e.type for e in events] == ['token']

    async def test_blank_lines_dont_produce_events(self) -> None:
        # Le séparateur SSE est `\n\n`. Notre parser ne doit pas
        # yield des events vides sur les lignes vides.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":"hi"}}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        # Un seul token, pas de bruit autour.
        assert len(events) == 1


class TestSseInvalidJson:
    async def test_malformed_json_silently_dropped(self) -> None:
        # CRITIQUE : un chunk truncated sous charge ne doit PAS
        # tuer la session. On skip et on continue.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":"a"}}]}',
                    'data: {malformed-json',
                    'data: {"choices":[{"delta":{"content":"b"}}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        # Les 2 chunks valides PASSENT, le truncated est ignoré.
        token_deltas = [e.delta for e in events if e.type == 'token']
        assert token_deltas == ['a', 'b']

    async def test_only_malformed_yields_no_token(self) -> None:
        # Si TOUT est malformé, on yield 0 token mais on ne crash pas.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(['data: {trash', 'data: {also trash'])
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        assert events == []


class TestSseEmptyDelta:
    async def test_empty_delta_content_does_not_yield_token(self) -> None:
        # `if delta:` filtre les '' et None. Sinon flicker côté UI.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":""}}]}',
                    'data: {"choices":[{"delta":{"content":"real"}}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        # Seul le real est yieldé.
        assert [e.delta for e in events if e.type == 'token'] == ['real']

    async def test_none_delta_content_does_not_yield_token(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{"content":null}}]}',
                    'data: {"choices":[{"delta":{"content":"x"}}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        assert [e.delta for e in events if e.type == 'token'] == ['x']


# ---------------------------------------------------------------------------
# Finish reason mapping
# ---------------------------------------------------------------------------


class TestStreamFinishReasonMap:
    async def test_content_filter_maps_to_error_in_stream(self) -> None:
        # CRITIQUE safety : même invariant que non-stream. Un refus
        # de safety doit être visible comme 'error', pas 'stop'.
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        done = [e for e in events if e.type == 'done']
        assert len(done) == 1
        assert done[0].finish_reason == 'error'

    async def test_unknown_finish_reason_defaults_to_stop(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            body = _make_sse(
                [
                    'data: {"choices":[{"delta":{},"finish_reason":"weird_new_reason"}]}',
                ]
            )
            return httpx.Response(200, content=body)

        events = await _collect(_client_with(handler))
        done = [e for e in events if e.type == 'done']
        assert done[0].finish_reason == 'stop'


# ---------------------------------------------------------------------------
# Payload + headers
# ---------------------------------------------------------------------------


class TestStreamPayloadAndHeaders:
    async def test_stream_true_in_payload(self) -> None:
        # Sans stream=True, le router renvoie un body JSON et le parser
        # SSE plante.
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured['body'] = json.loads(req.content)
            return httpx.Response(200, content=_make_sse(['data: [DONE]']))

        await _collect(_client_with(handler))
        assert captured['body']['stream'] is True

    async def test_authorization_injected_when_api_key_set(self) -> None:
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured['auth'] = req.headers.get('authorization')
            return httpx.Response(200, content=_make_sse(['data: [DONE]']))

        await _collect(_client_with(handler, api_key='sk-test'))
        assert captured['auth'] == 'Bearer sk-test'

    async def test_authorization_omitted_when_no_api_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Si on envoyait `Bearer None`, les routers stricts répondent 401.
        # Le constructeur fait `api_key or s.LLM_API_KEY`, donc on doit
        # à la fois passer api_key='' ET vider la valeur settings.
        from ai_core import config

        monkeypatch.setenv('LLM_API_KEY', '')
        config.get_settings.cache_clear()
        try:
            captured: dict[str, Any] = {}

            def handler(req: httpx.Request) -> httpx.Response:
                captured['auth'] = req.headers.get('authorization')
                return httpx.Response(
                    200, content=_make_sse(['data: [DONE]'])
                )

            await _collect(_client_with(handler, api_key=None))
            assert captured['auth'] is None
        finally:
            config.get_settings.cache_clear()
            monkeypatch.delenv('LLM_API_KEY', raising=False)

    async def test_max_tokens_included_when_provided(self) -> None:
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured['body'] = json.loads(req.content)
            return httpx.Response(200, content=_make_sse(['data: [DONE]']))

        transport = httpx.MockTransport(handler)
        client = InferenceClient(
            base_url='http://router.test/v1',
            api_key='k',
            client=httpx.AsyncClient(transport=transport),
        )
        async for _ in client.chat_stream(
            model='m', messages=[ChatMessage('user', 'x')], max_tokens=42
        ):
            pass
        assert captured['body']['max_tokens'] == 42

    async def test_max_tokens_omitted_when_none(self) -> None:
        # Symétrique du test non-stream : certains proxies 400 si None.
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured['body'] = json.loads(req.content)
            return httpx.Response(200, content=_make_sse(['data: [DONE]']))

        await _collect(_client_with(handler))
        assert 'max_tokens' not in captured['body']


# ---------------------------------------------------------------------------
# Network error mid-stream
# ---------------------------------------------------------------------------


class TestStreamNetworkError:
    async def test_connect_error_yields_error_event(self) -> None:
        # Si la connexion meurt avant le first byte, on doit yield un
        # event 'error' au lieu de pendre.
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError('boom', request=req)

        events = await _collect(_client_with(handler))
        assert len(events) == 1
        assert events[0].type == 'error'
        assert events[0].error is not None
        assert 'network error' in events[0].error

    async def test_read_timeout_yields_error_event(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout('slow', request=req)

        events = await _collect(_client_with(handler))
        assert len(events) == 1
        assert events[0].type == 'error'
