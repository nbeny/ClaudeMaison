"""Outils built-in du Jour-1.

- `echo` : utile pour valider le chemin gRPC bout-en-bout sans IO.
- `http_get` : GET HTTP simple, timeout court, taille de réponse plafonnée.
  L'allowlist d'URLs et la sandbox réseau viendront avec Firecracker (ADR-0009).
"""

from __future__ import annotations

from typing import Any

import httpx

from tools.config import get_settings

from .base import ToolDescriptor, ToolRegistry


async def _echo(args: dict[str, Any]) -> dict[str, Any]:
    message = args.get('message', '')
    if not isinstance(message, str):
        raise ValueError('message must be a string')
    return {'message': message}


async def _http_get(args: dict[str, Any]) -> dict[str, Any]:
    url = args.get('url')
    if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
        raise ValueError('url must be an absolute http(s) URL')
    s = get_settings()
    async with httpx.AsyncClient(timeout=s.TOOL_TIMEOUT_S, follow_redirects=False) as client:
        resp = await client.get(url)
        body = resp.content[: s.HTTP_MAX_BYTES]
        return {
            'status': resp.status_code,
            'headers': dict(resp.headers),
            'body': body.decode('utf-8', errors='replace'),
            'truncated': len(resp.content) > s.HTTP_MAX_BYTES,
        }


def build_default_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(
        ToolDescriptor(
            name='echo',
            description="Renvoie son entrée. Utile pour tester la chaîne d'appel.",
            arguments_schema={
                'type': 'object',
                'properties': {'message': {'type': 'string'}},
                'required': ['message'],
            },
            handler=_echo,
        )
    )
    reg.register(
        ToolDescriptor(
            name='http_get',
            description='GET HTTP. Pas de redirect, taille plafonnée.',
            arguments_schema={
                'type': 'object',
                'properties': {'url': {'type': 'string', 'format': 'uri'}},
                'required': ['url'],
            },
            handler=_http_get,
        )
    )
    return reg
