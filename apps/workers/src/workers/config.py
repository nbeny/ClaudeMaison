"""Settings workers — Redis + URL de retrieval."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=True,
        extra='ignore',
    )

    NODE_ENV: Literal['development', 'test', 'production'] = 'development'
    LOG_LEVEL: Literal['debug', 'info', 'warning', 'error'] = 'info'

    REDIS_URL: str = 'redis://localhost:6379/0'
    RETRIEVAL_URL: str = 'http://localhost:4100'

    # Concurrence Arq par worker.
    WORKER_MAX_JOBS: int = 8
    HTTP_TIMEOUT_S: float = 30.0

    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None
    OTEL_SERVICE_NAME: str = 'workers'


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
