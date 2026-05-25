"""Serveur gRPC.

L'import des stubs générés est différé pour que le module reste importable
même avant `scripts/gen-proto.sh`. Les tests unitaires couvrent l'executor
sans gRPC.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import grpc

from tools.executor import Executor
from tools.registry import ToolRegistry

if TYPE_CHECKING:  # pragma: no cover
    pass


class ToolServiceServicer:
    """Implémente tools.v1.ToolService.

    On reste dynamique (Any) côté requête/réponse pour ne pas dépendre des
    stubs au moment de l'import. Le bind se fait dans `serve()`.
    """

    def __init__(self, executor: Executor, registry: ToolRegistry) -> None:
        self._executor = executor
        self._registry = registry
        from tools.generated import tools_pb2  # local import — généré

        self._pb2 = tools_pb2

    async def ExecuteTool(self, request: Any, context: grpc.aio.ServicerContext) -> Any:
        result = await self._executor.execute(request.tool_name, request.arguments_json)
        return self._pb2.ExecuteToolResponse(
            status=result.status,
            result_json=result.result_json,
            error_message=result.error_message,
            duration_ms=result.duration_ms,
        )

    async def ListTools(self, request: Any, context: grpc.aio.ServicerContext) -> Any:
        tools = [
            self._pb2.ToolDescriptor(
                name=t.name,
                description=t.description,
                arguments_schema_json=json.dumps(t.arguments_schema, ensure_ascii=False),
            )
            for t in self._registry.list()
        ]
        return self._pb2.ListToolsResponse(tools=tools)


async def serve(host: str, port: int, registry: ToolRegistry) -> None:
    from tools.generated import tools_pb2_grpc  # généré

    server = grpc.aio.server()
    servicer = ToolServiceServicer(Executor(registry), registry)
    tools_pb2_grpc.add_ToolServiceServicer_to_server(servicer, server)  # type: ignore[no-untyped-call]
    server.add_insecure_port(f'{host}:{port}')
    await server.start()
    await server.wait_for_termination()
