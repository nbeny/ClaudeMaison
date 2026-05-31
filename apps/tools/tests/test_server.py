"""Caractérisation tools.server.ToolServiceServicer.

Le servicer est la couche de conversion entre les PB gRPC et le couple
(Executor, Registry). Il ne contient aucune logique métier — son seul
boulot est de bien câbler les noms de champs entre les deux mondes.
Mais c'est précisément ce câblage qu'on veut verrouiller :

  - ExecuteTool DOIT passer (request.tool_name, request.arguments_json)
    à executor.execute DANS CET ORDRE. Inverser les deux ferait que
    tous les outils renverraient 'unknown tool: {"message": "hi"}'.

  - Le mapping ExecutionResult → ExecuteToolResponse est 1:1 par nom
    de champ (status, result_json, error_message, duration_ms).
    Renommer un champ en silence côté PB sans répercuter ici =
    réponse vide envoyée au caller.

  - ListTools sérialise arguments_schema avec ensure_ascii=False.
    Sans ce flag, les accents français dans les descriptions seraient
    échappés (\u00e9 au lieu de é), inflant la taille des prompts
    système envoyés au LLM et dégradant la qualité du tool-use.

  - Pas de filtrage côté ListTools — on expose TOUT ce que le registry
    expose. Si on veut un jour filtrer par workspace, ça doit être
    une décision explicite, pas un side-effect d'une refacto.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from tools.executor import ExecutionResult
from tools.generated import tools_pb2
from tools.registry import ToolDescriptor, ToolRegistry
from tools.server import ToolServiceServicer


async def _noop(_: dict[str, Any]) -> dict[str, Any]:
    return {}


def _make_request(
    tool_name: str = 'echo', arguments_json: str = '{}'
) -> tools_pb2.ExecuteToolRequest:
    return tools_pb2.ExecuteToolRequest(
        tool_name=tool_name, arguments_json=arguments_json
    )


def _make_servicer(
    executor: Any = None, registry: ToolRegistry | None = None
) -> ToolServiceServicer:
    return ToolServiceServicer(
        executor=executor or MagicMock(), registry=registry or ToolRegistry()
    )


class TestExecuteToolDispatch:
    @pytest.mark.asyncio
    async def test_passes_tool_name_to_executor(self) -> None:
        # CRITIQUE : si l'ordre était inversé, tous les outils
        # tomberaient en 'unknown tool: <json>' au lieu de s'exécuter.
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult(
                status='ok', result_json='{}', error_message='', duration_ms=1.0
            )
        )
        servicer = _make_servicer(executor=executor)
        await servicer.ExecuteTool(
            _make_request(tool_name='http_get', arguments_json='{"url": "x"}'),
            context=MagicMock(),
        )
        args, _ = executor.execute.call_args
        assert args[0] == 'http_get'

    @pytest.mark.asyncio
    async def test_passes_arguments_json_to_executor(self) -> None:
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('ok', '{}', '', 1.0)
        )
        servicer = _make_servicer(executor=executor)
        await servicer.ExecuteTool(
            _make_request(arguments_json='{"foo": 42}'), context=MagicMock()
        )
        args, _ = executor.execute.call_args
        assert args[1] == '{"foo": 42}'

    @pytest.mark.asyncio
    async def test_passes_arguments_in_correct_order(self) -> None:
        # Verrouille (name, args) - inversion silencieuse fatale.
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('ok', '{}', '', 1.0)
        )
        servicer = _make_servicer(executor=executor)
        await servicer.ExecuteTool(
            _make_request(tool_name='A', arguments_json='B'),
            context=MagicMock(),
        )
        args, _ = executor.execute.call_args
        assert args == ('A', 'B')


class TestExecuteToolResponseMapping:
    @pytest.mark.asyncio
    async def test_maps_status_field(self) -> None:
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult(
                status='error', result_json='', error_message='boom', duration_ms=5.0
            )
        )
        servicer = _make_servicer(executor=executor)
        resp = await servicer.ExecuteTool(_make_request(), context=MagicMock())
        assert resp.status == 'error'

    @pytest.mark.asyncio
    async def test_maps_result_json_field(self) -> None:
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('ok', '{"k": 1}', '', 1.0)
        )
        servicer = _make_servicer(executor=executor)
        resp = await servicer.ExecuteTool(_make_request(), context=MagicMock())
        assert resp.result_json == '{"k": 1}'

    @pytest.mark.asyncio
    async def test_maps_error_message_field(self) -> None:
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('error', '', 'unknown tool: x', 0.5)
        )
        servicer = _make_servicer(executor=executor)
        resp = await servicer.ExecuteTool(_make_request(), context=MagicMock())
        assert resp.error_message == 'unknown tool: x'

    @pytest.mark.asyncio
    async def test_maps_duration_ms_field(self) -> None:
        # CRITIQUE pour observabilité : si duration_ms tombait à 0
        # silencieusement, on perdrait les métriques de perf côté
        # OTel collector.
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('ok', '{}', '', 42.5)
        )
        servicer = _make_servicer(executor=executor)
        resp = await servicer.ExecuteTool(_make_request(), context=MagicMock())
        assert resp.duration_ms == 42.5

    @pytest.mark.asyncio
    async def test_returns_execute_tool_response_type(self) -> None:
        executor = MagicMock()
        executor.execute = AsyncMock(
            return_value=ExecutionResult('ok', '{}', '', 1.0)
        )
        servicer = _make_servicer(executor=executor)
        resp = await servicer.ExecuteTool(_make_request(), context=MagicMock())
        assert isinstance(resp, tools_pb2.ExecuteToolResponse)


class TestListTools:
    @pytest.mark.asyncio
    async def test_returns_empty_list_for_empty_registry(self) -> None:
        servicer = _make_servicer(registry=ToolRegistry())
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        assert list(resp.tools) == []

    @pytest.mark.asyncio
    async def test_returns_one_descriptor_per_tool(self) -> None:
        reg = ToolRegistry()
        reg.register(
            ToolDescriptor(
                name='a', description='', arguments_schema={'type': 'object'}, handler=_noop
            )
        )
        reg.register(
            ToolDescriptor(
                name='b', description='', arguments_schema={'type': 'object'}, handler=_noop
            )
        )
        servicer = _make_servicer(registry=reg)
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        assert len(list(resp.tools)) == 2

    @pytest.mark.asyncio
    async def test_descriptor_name_field(self) -> None:
        reg = ToolRegistry()
        reg.register(
            ToolDescriptor(
                name='http_get',
                description='',
                arguments_schema={},
                handler=_noop,
            )
        )
        servicer = _make_servicer(registry=reg)
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        assert resp.tools[0].name == 'http_get'

    @pytest.mark.asyncio
    async def test_descriptor_description_field(self) -> None:
        reg = ToolRegistry()
        reg.register(
            ToolDescriptor(
                name='x',
                description='GET HTTP. Pas de redirect.',
                arguments_schema={},
                handler=_noop,
            )
        )
        servicer = _make_servicer(registry=reg)
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        assert resp.tools[0].description == 'GET HTTP. Pas de redirect.'

    @pytest.mark.asyncio
    async def test_arguments_schema_serialized_as_json_string(self) -> None:
        # Le PB stocke schema comme string. Le caller LLM le parse en
        # JSON. Donc ce qui sort ici DOIT être du JSON valide.
        import json

        reg = ToolRegistry()
        reg.register(
            ToolDescriptor(
                name='x',
                description='',
                arguments_schema={
                    'type': 'object',
                    'properties': {'foo': {'type': 'string'}},
                    'required': ['foo'],
                },
                handler=_noop,
            )
        )
        servicer = _make_servicer(registry=reg)
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        parsed = json.loads(resp.tools[0].arguments_schema_json)
        assert parsed['type'] == 'object'
        assert parsed['required'] == ['foo']

    @pytest.mark.asyncio
    async def test_arguments_schema_preserves_unicode(self) -> None:
        # CRITIQUE : ensure_ascii=False préserve les accents français.
        # Si quelqu'un repasse à ensure_ascii=True (défaut Python),
        # 'éphémère' devient '\u00e9ph\u00e9m\u00e8re' qui :
        #   - inflate la taille du prompt système (~2.5x bytes)
        #   - dégrade la qualité du tool-use car le modèle voit du
        #     bruit au lieu du français.
        reg = ToolRegistry()
        reg.register(
            ToolDescriptor(
                name='x',
                description='',
                arguments_schema={'description': 'éphémère contexte été'},
                handler=_noop,
            )
        )
        servicer = _make_servicer(registry=reg)
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        # Les accents bruts doivent apparaître dans le JSON wire.
        assert 'éphémère' in resp.tools[0].arguments_schema_json
        assert 'été' in resp.tools[0].arguments_schema_json
        assert '\\u00e9' not in resp.tools[0].arguments_schema_json

    @pytest.mark.asyncio
    async def test_returns_list_tools_response_type(self) -> None:
        servicer = _make_servicer(registry=ToolRegistry())
        resp = await servicer.ListTools(
            tools_pb2.ListToolsRequest(), context=MagicMock()
        )
        assert isinstance(resp, tools_pb2.ListToolsResponse)


class TestServicerConstruction:
    def test_stores_pb2_module_for_dynamic_use(self) -> None:
        # Le servicer fait un import différé tools_pb2 dans __init__.
        # Si on retirait ce stockage, ExecuteTool/ListTools tomberaient
        # sur _pb2 inexistant au runtime.
        servicer = _make_servicer()
        assert servicer._pb2 is tools_pb2
