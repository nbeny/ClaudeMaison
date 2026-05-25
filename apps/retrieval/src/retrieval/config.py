"""Configuration via pydantic-settings — même contrat que ai-core."""

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
    HTTP_PORT: int = Field(default=4100, ge=1, le=65_535)
    HTTP_HOST: str = '0.0.0.0'
    LOG_LEVEL: Literal['debug', 'info', 'warning', 'error'] = 'info'

    QDRANT_URL: str = 'http://localhost:6333'
    QDRANT_API_KEY: str | None = None
    QDRANT_COLLECTION: str = 'documents'

    # Dimensions du vecteur d'embedding. BGE-large-fr produit du 1024. À aligner
    # avec ce qu'on lit côté Qdrant. Voir ADR-0007.
    EMBEDDING_DIM: int = 1024

    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None
    OTEL_SERVICE_NAME: str = 'retrieval'


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
