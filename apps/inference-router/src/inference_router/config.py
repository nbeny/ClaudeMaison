"""Settings inference-router.

Le routing est défini par MODEL_BACKENDS, une chaîne au format :
    "model=backend1,backend2;model2=backend3"

Chaque backend a la syntaxe :
    [<provider>:]<url>[|prio:<int>][|env:<ENV_VAR_NAME>]

Exemples :
    m1=http://vllm:8000
    big=mistral:https://api.mistral.ai|env:MISTRAL_API_KEY
    mix=http://primary|prio:0,mistral:https://api.mistral.ai|prio:1|env:MISTRAL_API_KEY

Le provider par défaut est `llama-cpp`. Les backends sont essayés par
priorité croissante (0 d'abord), avec round-robin à l'intérieur d'un même
groupe de priorité. C'est pragmatique pour Jour-1 ; quand on aura plus de
modèles, on passera à un fichier YAML monté.
"""

from __future__ import annotations

from dataclasses import dataclass
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

    # "model=[<provider>:]<url>[|prio:N][|env:VAR],... ; model2=..."
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


@dataclass(frozen=True, slots=True)
class BackendConfig:
    url: str
    provider: str = 'llama-cpp'
    priority: int = 0
    api_key_env: str | None = None


def _parse_single_backend(raw: str) -> BackendConfig:
    raw = raw.strip()
    if not raw:
        raise ValueError('empty backend entry')
    parts = raw.split('|')
    head = parts[0]
    options = parts[1:]

    provider = 'llama-cpp'
    url = head
    if ':' in head:
        candidate_provider, rest = head.split(':', 1)
        if candidate_provider not in ('http', 'https'):
            provider = candidate_provider
            url = rest

    if not url:
        raise ValueError(f'no URL in backend entry: {raw!r}')

    priority = 0
    api_key_env: str | None = None
    for opt in options:
        key, _, value = opt.partition(':')
        if key == 'prio':
            try:
                priority = int(value)
            except ValueError as e:
                raise ValueError(f'invalid priority in {opt!r}') from e
        elif key == 'env':
            api_key_env = value
        else:
            raise ValueError(f'unknown backend option: {opt!r}')

    return BackendConfig(url=url, provider=provider, priority=priority, api_key_env=api_key_env)


def parse_model_backends(spec: str) -> dict[str, list[BackendConfig]]:
    """Parse "m1=[prov:]url[|opt]*,...;m2=..." en dict[model, list[BackendConfig]]."""
    result: dict[str, list[BackendConfig]] = {}
    if not spec:
        return result
    for entry in spec.split(';'):
        entry = entry.strip()
        if not entry:
            continue
        if '=' not in entry:
            raise ValueError(f'invalid MODEL_BACKENDS entry: {entry!r}')
        name, urls = entry.split('=', 1)
        backends = [_parse_single_backend(u) for u in urls.split(',') if u.strip()]
        if not backends:
            raise ValueError(f'no backends for model: {name!r}')
        result[name.strip()] = backends
    return result
