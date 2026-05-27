"""Entrypoint du binaire ai-core.

Ordre d'init :
1. start_telemetry() — AVANT d'importer/instrumenter quoi que ce soit.
2. configure_logging() — structlog branché sur stdout.
3. uvicorn run de l'app FastAPI.

Le serveur gRPC sera démarré en parallèle (asyncio.gather) quand le code
proto sera généré ; pour l'instant on garde le binaire mono-protocol HTTP.
"""

from __future__ import annotations

# Telemetry MUST be first — voir docstring du module.
from ai_core.telemetry import start_telemetry

start_telemetry()

import asyncio  # noqa: E402

import nats  # noqa: E402
import uvicorn  # noqa: E402

from ai_core.config import get_settings  # noqa: E402
from ai_core.events import EventPublisher  # noqa: E402
from ai_core.http import create_app  # noqa: E402
from ai_core.inference import InferenceClient  # noqa: E402
from ai_core.logging import configure_logging, get_logger  # noqa: E402
from ai_core.orchestrator import Orchestrator  # noqa: E402


async def _bootstrap() -> None:
    """Ouvre NATS, câble l'Orchestrator, démarre Uvicorn."""
    configure_logging()
    settings = get_settings()
    logger = get_logger(__name__)
    logger.info(
        'ai-core boot',
        port=settings.HTTP_PORT,
        host=settings.HTTP_HOST,
        env=settings.NODE_ENV,
    )

    nc = await nats.connect(settings.NATS_URL)
    publisher = EventPublisher(connection=nc)
    orchestrator = Orchestrator(
        inference=InferenceClient(),
        publisher=publisher,
    )

    app = create_app(orchestrator=orchestrator)

    config = uvicorn.Config(
        app,
        host=settings.HTTP_HOST,
        port=settings.HTTP_PORT,
        log_config=None,   # structlog gère déjà le rendu, pas de double config.
        access_log=False,  # OTel HTTP instrumentation produit les access logs.
    )
    server = uvicorn.Server(config)
    # Phase 1 : les BackgroundTasks en cours au moment du SIGTERM ne sont pas trackées.
    # Migrer vers asyncio.TaskGroup + cancel propre en Phase 2.
    try:
        await server.serve()
    finally:
        await orchestrator.aclose()
        await nc.drain()


def run() -> None:
    asyncio.run(_bootstrap())


if __name__ == '__main__':
    run()
