"""Point d'entrée retrieval. Telemetry d'abord, le reste après."""

from __future__ import annotations

from retrieval.telemetry import start_telemetry

start_telemetry()

import uvicorn  # noqa: E402

from retrieval.config import get_settings  # noqa: E402
from retrieval.http import create_app  # noqa: E402
from retrieval.logging import configure_logging  # noqa: E402


def run() -> None:
    configure_logging()
    settings = get_settings()
    uvicorn.run(
        create_app(),
        host=settings.HTTP_HOST,
        port=settings.HTTP_PORT,
        log_config=None,
        access_log=False,
    )


if __name__ == '__main__':
    run()
