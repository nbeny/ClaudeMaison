"""Registre d'outils — pure Python, sans dépendance gRPC.

C'est ici qu'on déclare les outils disponibles. Chaque outil expose un nom,
une description, un schéma JSON d'arguments et une coroutine d'exécution.
"""

from __future__ import annotations

from .base import ToolDescriptor, ToolRegistry
from .builtins import build_default_registry

__all__ = ['ToolDescriptor', 'ToolRegistry', 'build_default_registry']
