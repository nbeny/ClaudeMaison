"""Sélection round-robin du backend pour un modèle donné.

Thread-safe via itertools.cycle protégé par un Lock — overkill pour Jour-1
mais évite les surprises si on passe en multi-thread plus tard.
"""

from __future__ import annotations

import itertools
import threading
from collections.abc import Iterator


class BackendRouter:
    def __init__(self, model_backends: dict[str, list[str]]) -> None:
        self._backends = {m: list(urls) for m, urls in model_backends.items()}
        self._cycles: dict[str, Iterator[str]] = {
            m: itertools.cycle(urls) for m, urls in self._backends.items()
        }
        self._lock = threading.Lock()

    def models(self) -> list[str]:
        return sorted(self._backends.keys())

    def pick(self, model: str) -> str:
        with self._lock:
            cycle = self._cycles.get(model)
            if cycle is None:
                raise KeyError(model)
            return next(cycle)
