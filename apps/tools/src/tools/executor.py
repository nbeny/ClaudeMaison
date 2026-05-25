"""Couche d'exécution : registry + timeout + sérialisation JSON.

Indépendante de gRPC pour pouvoir être testée sans serveur.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

from tools.config import get_settings
from tools.registry import ToolRegistry


@dataclass(frozen=True)
class ExecutionResult:
    status: str  # 'ok' | 'error'
    result_json: str
    error_message: str
    duration_ms: float


class Executor:
    def __init__(self, registry: ToolRegistry) -> None:
        self._registry = registry

    async def execute(self, tool_name: str, arguments_json: str) -> ExecutionResult:
        start = time.perf_counter()
        tool = self._registry.get(tool_name)
        if tool is None:
            return _error(f'unknown tool: {tool_name}', start)

        try:
            args = json.loads(arguments_json) if arguments_json else {}
        except json.JSONDecodeError as exc:
            return _error(f'invalid arguments_json: {exc}', start)
        if not isinstance(args, dict):
            return _error('arguments_json must decode to an object', start)

        timeout = get_settings().TOOL_TIMEOUT_S
        try:
            result: Any = await asyncio.wait_for(tool.handler(args), timeout=timeout)
        except TimeoutError:
            return _error(f'tool timed out after {timeout}s', start)
        except Exception as exc:  # outils tiers : on capture tout
            return _error(f'{type(exc).__name__}: {exc}', start)

        return ExecutionResult(
            status='ok',
            result_json=json.dumps(result, ensure_ascii=False, default=str),
            error_message='',
            duration_ms=(time.perf_counter() - start) * 1000.0,
        )


def _error(msg: str, start: float) -> ExecutionResult:
    return ExecutionResult(
        status='error',
        result_json='',
        error_message=msg,
        duration_ms=(time.perf_counter() - start) * 1000.0,
    )
