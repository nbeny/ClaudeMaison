"""Tests de l'executor — sans gRPC, donc utilisables même sans stubs générés."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from tools.executor import Executor
from tools.registry import ToolRegistry
from tools.registry.base import ToolDescriptor
from tools.registry.builtins import build_default_registry


def _registry_with(handler: Any, name: str = 'x') -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(
        ToolDescriptor(
            name=name,
            description='',
            arguments_schema={'type': 'object'},
            handler=handler,
        )
    )
    return reg


async def test_echo_roundtrip() -> None:
    exec_ = Executor(build_default_registry())
    result = await exec_.execute('echo', json.dumps({'message': 'hi'}))
    assert result.status == 'ok'
    assert json.loads(result.result_json) == {'message': 'hi'}


async def test_unknown_tool() -> None:
    result = await Executor(ToolRegistry()).execute('nope', '{}')
    assert result.status == 'error'
    assert 'unknown tool' in result.error_message


async def test_invalid_arguments_json() -> None:
    result = await Executor(build_default_registry()).execute('echo', 'not-json')
    assert result.status == 'error'
    assert 'invalid arguments_json' in result.error_message


async def test_arguments_must_be_object() -> None:
    result = await Executor(build_default_registry()).execute('echo', '[]')
    assert result.status == 'error'
    assert 'must decode to an object' in result.error_message


async def test_handler_exception_is_captured() -> None:
    async def boom(_: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError('kaboom')

    result = await Executor(_registry_with(boom)).execute('x', '{}')
    assert result.status == 'error'
    assert 'RuntimeError: kaboom' in result.error_message


async def test_handler_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    async def slow(_: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(1.0)
        return {}

    # Plafonne le timeout à un palier court pour ce test.
    from tools import config

    config.get_settings.cache_clear()
    monkeypatch.setenv('TOOL_TIMEOUT_S', '0.05')
    try:
        result = await Executor(_registry_with(slow)).execute('x', '{}')
    finally:
        config.get_settings.cache_clear()
        monkeypatch.delenv('TOOL_TIMEOUT_S', raising=False)

    assert result.status == 'error'
    assert 'timed out' in result.error_message
