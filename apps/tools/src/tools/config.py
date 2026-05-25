"""Settings — gRPC server config."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=True,
        extra='ignore',
    )

    NODE_ENV: Literal['development', 'test', 'production'] = 'development'
    GRPC_PORT: int = Field(default=5005, ge=1, le=65_535)
    GRPC_HOST: str = '0.0.0.0'
    LOG_LEVEL: Literal['debug', 'info', 'warning', 'error'] = 'info'

    # Limites d'exécution. Plafonds bas tant qu'on n'a pas de sandbox.
    TOOL_TIMEOUT_S: float = 5.0
    HTTP_MAX_BYTES: int = 1_048_576

    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None
    OTEL_SERVICE_NAME: str = 'tools'


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
