"""Entrée workers. Démarre Arq via son runner programmatique."""

from __future__ import annotations

from workers.telemetry import start_telemetry

start_telemetry()

from arq.worker import run_worker  # noqa: E402

from workers.logging import configure_logging  # noqa: E402
from workers.worker import WorkerSettings  # noqa: E402


def run() -> None:
    configure_logging()
    run_worker(WorkerSettings)  # type: ignore[arg-type]


if __name__ == '__main__':
    run()
