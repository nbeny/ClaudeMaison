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

import uvicorn  # noqa: E402

from ai_core.config import get_settings  # noqa: E402
from ai_core.http import create_app  # noqa: E402
from ai_core.logging import configure_logging, get_logger  # noqa: E402


def run() -> None:
    configure_logging()
    settings = get_settings()
    logger = get_logger(__name__)
    logger.info(
        'ai-core boot',
        port=settings.HTTP_PORT,
        host=settings.HTTP_HOST,
        env=settings.NODE_ENV,
    )
    uvicorn.run(
        create_app(),
        host=settings.HTTP_HOST,
        port=settings.HTTP_PORT,
        log_config=None,  # structlog gère déjà le rendu, pas de double config.
        access_log=False,  # OTel HTTP instrumentation produit les access logs.
    )


if __name__ == '__main__':
    run()
