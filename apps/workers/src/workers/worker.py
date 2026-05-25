"""Settings Arq : tâches, hooks startup/shutdown, Redis."""

from __future__ import annotations

from arq.connections import RedisSettings

from workers.config import get_settings
from workers.jobs import ingest_document, shutdown, startup


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(get_settings().REDIS_URL)


class WorkerSettings:
    functions = [ingest_document]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = get_settings().WORKER_MAX_JOBS
    redis_settings = _redis_settings()
