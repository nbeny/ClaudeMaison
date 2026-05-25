"""Client OpenAI-compatible vers inference-router.

Pas de SDK OpenAI : le protocole est trivial et on évite la dépendance + le
phone-home par défaut du SDK. httpx async, on parse juste le premier choice.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import httpx

from ai_core.config import get_settings


class InferenceError(RuntimeError):
    """Erreur retournée par inference-router ou réseau."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(slots=True)
class ChatMessage:
    role: Literal['system', 'user', 'assistant']
    content: str


@dataclass(slots=True)
class ChatCompletion:
    text: str
    finish_reason: Literal['stop', 'length', 'tool_call', 'error']
    model: str
    raw: dict[str, Any]


_FINISH_REASON_MAP: dict[str, Literal['stop', 'length', 'tool_call', 'error']] = {
    'stop': 'stop',
    'length': 'length',
    'tool_calls': 'tool_call',
    'function_call': 'tool_call',
    'content_filter': 'error',
}


class InferenceClient:
    """Wrapper minimal sur /v1/chat/completions.

    Le client tient son propre AsyncClient httpx — fermé via `aclose()` ou via
    context manager. Le base_url inclut déjà `/v1`.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_s: float | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        s = get_settings()
        self._base_url = (base_url or s.LLM_BASE_URL).rstrip('/')
        self._api_key = api_key or s.LLM_API_KEY
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=timeout_s or s.LLM_TIMEOUT_S)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> InferenceClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def chat(
        self,
        *,
        model: str,
        messages: list[ChatMessage],
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> ChatCompletion:
        payload: dict[str, Any] = {
            'model': model,
            'messages': [{'role': m.role, 'content': m.content} for m in messages],
            'temperature': temperature,
            'stream': False,
        }
        if max_tokens is not None:
            payload['max_tokens'] = max_tokens

        headers = {'Authorization': f'Bearer {self._api_key}'} if self._api_key else {}
        try:
            resp = await self._client.post(
                f'{self._base_url}/chat/completions',
                json=payload,
                headers=headers,
            )
        except httpx.HTTPError as exc:
            raise InferenceError(f'network error: {exc}') from exc

        if resp.status_code >= 400:
            raise InferenceError(
                f'inference-router {resp.status_code}: {resp.text[:200]}',
                status=resp.status_code,
            )

        body = resp.json()
        choices = body.get('choices') or []
        if not choices:
            raise InferenceError('inference-router returned no choices')
        choice = choices[0]
        text = (choice.get('message') or {}).get('content', '') or ''
        raw_reason = choice.get('finish_reason') or 'stop'
        finish: Literal['stop', 'length', 'tool_call', 'error'] = _FINISH_REASON_MAP.get(
            raw_reason, 'stop'
        )
        return ChatCompletion(
            text=text,
            finish_reason=finish,
            model=str(body.get('model', model)),
            raw=body,
        )
