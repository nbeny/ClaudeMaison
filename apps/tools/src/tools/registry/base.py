"""Types de base pour le registre d'outils."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

ToolHandler = Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class ToolDescriptor:
    name: str
    description: str
    arguments_schema: dict[str, Any]
    handler: ToolHandler


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDescriptor] = {}

    def register(self, tool: ToolDescriptor) -> None:
        if tool.name in self._tools:
            raise ValueError(f'tool already registered: {tool.name}')
        self._tools[tool.name] = tool

    def get(self, name: str) -> ToolDescriptor | None:
        return self._tools.get(name)

    def list(self) -> list[ToolDescriptor]:
        return list(self._tools.values())
