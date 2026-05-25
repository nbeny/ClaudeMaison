"""Logging structuré via structlog — équivalent pino côté Node.

JSON en prod, console formatée en dev. Les keys sont écrasées par tout
processeur OTel qui ajoute trace_id/span_id automatiquement.
"""

import logging
import sys

import structlog

from ai_core.config import get_settings


def configure_logging() -> None:
    settings = get_settings()
    level = getattr(logging, settings.LOG_LEVEL.upper())

    logging.basicConfig(
        format='%(message)s',
        stream=sys.stdout,
        level=level,
    )

    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt='iso'),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    renderer: structlog.types.Processor = (
        structlog.dev.ConsoleRenderer(colors=True)
        if settings.NODE_ENV == 'development'
        else structlog.processors.JSONRenderer()
    )
    processors: list[structlog.types.Processor] = [*shared_processors, renderer]

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)  # type: ignore[no-any-return]
