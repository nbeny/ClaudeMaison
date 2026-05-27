"""Tests chat_stream — parsing du flux SSE OpenAI-compatible via MockTransport."""

from __future__ import annotations

import httpx

from ai_core.inference import InferenceClient
from ai_core.inference.client import ChatMessage


def _build_sse(chunks: list[str], finish_reason: str = 'stop') -> str:
    lines: list[str] = []
    for c in chunks:
        lines.append(
            'data: ' + ('{"choices":[{"delta":{"content":"' + c + '"},"finish_reason":null}]}')
        )
    lines.append('data: ' + ('{"choices":[{"delta":{},"finish_reason":"' + finish_reason + '"}]}'))
    lines.append('data: [DONE]')
    return '\n\n'.join(lines) + '\n\n'


async def test_chat_stream_yields_text_deltas() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        import json

        body = json.loads(req.content)
        assert body['stream'] is True
        return httpx.Response(
            200,
            headers={'content-type': 'text/event-stream'},
            content=_build_sse(['Hel', 'lo']).encode(),
        )

    transport = httpx.MockTransport(handler)
    client = InferenceClient(
        base_url='http://router.test/v1',
        api_key='k',
        client=httpx.AsyncClient(transport=transport),
    )
    out: list[tuple[str, str]] = []
    async for evt in client.chat_stream(model='m', messages=[ChatMessage('user', 'hi')]):
        out.append((evt.type, evt.delta or evt.finish_reason or ''))
    assert ('token', 'Hel') in out
    assert ('token', 'lo') in out
    assert ('done', 'stop') in out
    await client.aclose()


async def test_chat_stream_yields_error_on_5xx() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, content=b'all_backends_failed')

    transport = httpx.MockTransport(handler)
    client = InferenceClient(
        base_url='http://router.test/v1',
        api_key='k',
        client=httpx.AsyncClient(transport=transport),
    )
    events: list[tuple[str, str | None]] = []
    async for evt in client.chat_stream(model='m', messages=[ChatMessage('user', 'hi')]):
        events.append((evt.type, evt.error))
    assert len(events) == 1
    assert events[0][0] == 'error'
    assert events[0][1] is not None
    assert 'all_backends_failed' in events[0][1]
    await client.aclose()
