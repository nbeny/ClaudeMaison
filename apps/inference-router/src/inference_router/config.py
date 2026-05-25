"""Settings inference-router.

Le routing est défini par MODEL_BACKENDS, une chaîne au format :
    "model-a=http://vllm-a:8000,http://vllm-a2:8000;model-b=http://llama:8080"

C'est pragmatique pour Jour-1 ; quand on aura plus de modèles, on passera
à un fichier YAML monté.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=True,
        extra='ignore',
    )

    NODE_ENV: Literal['development', 'test', 'production'] = 'development'
    HTTP_PORT: int = Field(default=4200, ge=1, le=65_535)
    HTTP_HOST: str = '0.0.0.0'
    LOG_LEVEL: Literal['debug', 'info', 'warning', 'error'] = 'info'

    # "model=url1,url2;model2=url3"
    MODEL_BACKENDS: str = ''

    # Timeout par requête backend. Volontairement large : génération streaming.
    BACKEND_TIMEOUT_S: float = 120.0

    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None
    OTEL_SERVICE_NAME: str = 'inference-router'

    @field_validator('MODEL_BACKENDS')
    @classmethod
    def _normalize(cls, v: str) -> str:
        return v.strip()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def parse_model_backends(spec: str) -> dict[str, list[str]]:
    """Parse "m1=u1,u2;m2=u3" en {m1: [u1,u2], m2: [u3]}."""
    result: dict[str, list[str]] = {}
    if not spec:
        return result
    for entry in spec.split(';'):
        entry = entry.strip()
        if not entry:
            continue
        if '=' not in entry:
            raise ValueError(f'invalid MODEL_BACKENDS entry: {entry!r}')
        name, urls = entry.split('=', 1)
        urls_list = [u.strip() for u in urls.split(',') if u.strip()]
        if not urls_list:
            raise ValueError(f'no backends for model: {name!r}')
        result[name.strip()] = urls_list
    return result
