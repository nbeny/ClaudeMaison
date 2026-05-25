"""Entrée tools. Telemetry d'abord, puis serveur gRPC."""

from __future__ import annotations

from tools.telemetry import start_telemetry

start_telemetry()

import asyncio  # noqa: E402

from tools.config import get_settings  # noqa: E402
from tools.logging import configure_logging, get_logger  # noqa: E402
from tools.registry import build_default_registry  # noqa: E402
from tools.server import serve  # noqa: E402


def run() -> None:
    configure_logging()
    settings = get_settings()
    logger = get_logger('tools')
    logger.info('tools.start', host=settings.GRPC_HOST, port=settings.GRPC_PORT)
    asyncio.run(serve(settings.GRPC_HOST, settings.GRPC_PORT, build_default_registry()))


if __name__ == '__main__':
    run()
