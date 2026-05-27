"""Routing par modèle avec groupes de priorité et fallback.

Pour chaque modèle, les backends sont regroupés par priorité croissante
(0 d'abord). `attempts()` retourne UN pick par groupe — round-robin à
l'intérieur d'un groupe, ordre de priorité entre groupes. Le caller
(HTTP layer) essaie les picks dans l'ordre jusqu'au premier succès.

Thread-safe via Lock — overkill pour Jour-1 mais évite les surprises.
"""

from __future__ import annotations

import itertools
import threading
from collections.abc import Iterator
from dataclasses import dataclass

from inference_router.config import BackendConfig


@dataclass(frozen=True, slots=True)
class BackendPick:
    backend: BackendConfig
    group_index: int


class BackendRouter:
    def __init__(self, model_backends: dict[str, list[BackendConfig]]) -> None:
        self._groups: dict[str, list[list[BackendConfig]]] = {}
        self._cycles: dict[tuple[str, int], Iterator[BackendConfig]] = {}
        for model, backends in model_backends.items():
            ordered = sorted(backends, key=lambda b: b.priority)
            groups: list[list[BackendConfig]] = []
            for _, items in itertools.groupby(ordered, key=lambda b: b.priority):
                group = list(items)
                groups.append(group)
            self._groups[model] = groups
            for idx, group in enumerate(groups):
                self._cycles[(model, idx)] = itertools.cycle(group)
        self._lock = threading.Lock()

    def models(self) -> list[str]:
        return sorted(self._groups.keys())

    def attempts(self, model: str) -> list[BackendPick]:
        groups = self._groups.get(model)
        if groups is None:
            raise KeyError(model)
        picks: list[BackendPick] = []
        with self._lock:
            for idx, _ in enumerate(groups):
                cycle = self._cycles[(model, idx)]
                picks.append(BackendPick(backend=next(cycle), group_index=idx))
        return picks
