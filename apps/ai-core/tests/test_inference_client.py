"""Tests du client OpenAI-compatible. Stub via httpx.MockTransport."""

from __future__ import annotations

import httpx
import pytest

from ai_core.inference import InferenceClient, InferenceError
from ai_core.inference.client import ChatMessage


def _client_with(handler: object) -> InferenceClient:
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    return InferenceClient(
        base_url='http://router.test/v1',
        api_key='test',
        client=httpx.AsyncClient(transport=transport),
    )


async def test_chat_parses_first_choice() -> None:
    captured: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured['url'] = str(req.url)
        captured['auth'] = req.headers.get('authorization')
        return httpx.Response(
            200,
            json={
                'model': 'm',
                'choices': [
                    {'message': {'content': 'hi'}, 'finish_reason': 'stop'},
                ],
            },
        )

    client = _client_with(handler)
    out = await client.chat(model='m', messages=[ChatMessage(role='user', content='hello')])
    assert out.text == 'hi'
    assert out.finish_reason == 'stop'
    assert captured['url'] == 'http://router.test/v1/chat/completions'
    assert captured['auth'] == 'Bearer test'
    await client.aclose()


async def test_chat_maps_tool_calls_finish_reason() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                'model': 'm',
                'choices': [{'message': {'content': ''}, 'finish_reason': 'tool_calls'}],
            },
        )

    out = await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'hi')])
    assert out.finish_reason == 'tool_call'


async def test_chat_raises_on_4xx() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text='rate limit')

    with pytest.raises(InferenceError) as ei:
        await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])
    assert ei.value.status == 429


async def test_chat_raises_on_empty_choices() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'model': 'm', 'choices': []})

    with pytest.raises(InferenceError):
        await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])


async def test_injected_client_is_not_closed_by_aclose() -> None:
    """Si l'appelant fournit son AsyncClient, c'est lui qui le ferme."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                'model': 'm',
                'choices': [{'message': {'content': 'x'}, 'finish_reason': 'stop'}],
            },
        )

    injected = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = InferenceClient(base_url='http://r.test/v1', api_key='k', client=injected)
    await client.aclose()
    # injected client toujours utilisable
    out = await client.chat(model='m', messages=[ChatMessage('user', 'hi')])
    assert out.text == 'x'
    await injected.aclose()


async def test_network_error_is_wrapped() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('boom')

    with pytest.raises(InferenceError) as ei:
        await _client_with(handler).chat(model='m', messages=[ChatMessage('user', 'x')])
    assert 'network error' in str(ei.value)
