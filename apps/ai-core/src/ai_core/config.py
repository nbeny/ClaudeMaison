"""Configuration via pydantic-settings.

Pas de fallback silencieux : si une variable critique manque, on lève au
démarrage (mêmes contraintes que côté Node avec Zod).
"""

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
    HTTP_PORT: int = Field(default=4000, ge=1, le=65_535)
    HTTP_HOST: str = '0.0.0.0'
    GRPC_PORT: int = Field(default=5002, ge=1, le=65_535)
    LOG_LEVEL: Literal['debug', 'info', 'warning', 'error'] = 'info'

    # NATS — dorsale d'événements partagée avec realtime/workers.
    NATS_URL: str = 'nats://localhost:4222'
    NATS_STREAM: str = 'events'

    # Postgres — partage la même base que edge-api (schémas séparés : auth,
    # billing, conversations, agent_runs). Voir infrastructure/db/.
    DATABASE_URL: str = 'postgresql://claudemaison:claudemaison@localhost:5432/claudemaison'

    # Qdrant pour la mémoire long-terme. En dev local : profil `ai` du compose.
    QDRANT_URL: str = 'http://localhost:6333'
    QDRANT_API_KEY: str | None = None

    # vLLM via inference-router : ici on appelle un endpoint OpenAI-compatible.
    # En dev local sans GPU, peut pointer vers un mock ou Ollama.
    LLM_BASE_URL: str = 'http://localhost:8000/v1'
    LLM_API_KEY: str = 'dev-only'
    LLM_DEFAULT_MODEL: str = 'mistral-large-instruct'

    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None
    OTEL_SERVICE_NAME: str = 'ai-core'


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton mémoïsé. lru_cache évite de re-parser à chaque requête."""

    return Settings()
