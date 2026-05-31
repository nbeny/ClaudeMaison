"""Caractérisation workers.config — Settings + lru_cache.

Workers ingèrent dans Qdrant via le service retrieval. Défauts à
verrouiller :

  - REDIS_URL=redis://localhost:6379/0 (DB 0, partagé avec edge-api).
  - RETRIEVAL_URL=http://localhost:4100 (PAS 4000 ou 4200).
  - WORKER_MAX_JOBS=8 (concurrence Arq par worker).
  - HTTP_TIMEOUT_S=30.0 (PAS 5s, embedding+indexing peut être lent).
  - OTEL_SERVICE_NAME='workers' (PAS 'ai-core' / 'retrieval').
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from workers.config import Settings, get_settings


def _settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[arg-type]


class TestDefaults:
    def test_node_env_default_is_development(self) -> None:
        assert _settings().NODE_ENV == 'development'

    def test_log_level_default_info(self) -> None:
        assert _settings().LOG_LEVEL == 'info'

    def test_redis_url_default_db_0(self) -> None:
        # DB 0 par convention monorepo. edge-api utilise aussi DB 0.
        # Si on bascule sur /1 sans coordination, les workers ne voient
        # pas les jobs poussés par l'API.
        assert _settings().REDIS_URL == 'redis://localhost:6379/0'

    def test_retrieval_url_default_4100(self) -> None:
        # Contrat docker-compose : retrieval ecoute sur 4100.
        # Si on tape 4000 (ai-core), les workers feraient POST /ingest
        # contre ai-core qui retourne 404, et les documents seraient
        # silencieusement perdus.
        assert _settings().RETRIEVAL_URL == 'http://localhost:4100'

    def test_worker_max_jobs_default_8(self) -> None:
        # Concurrence Arq par worker. Trop bas => backpressure ;
        # trop haut => OOM sur les gros embeddings.
        assert _settings().WORKER_MAX_JOBS == 8

    def test_http_timeout_default_30s(self) -> None:
        # Embedding+indexing peut prendre plusieurs secondes pour des
        # docs longs. Un timeout 5s causerait des retries infinis Arq.
        assert _settings().HTTP_TIMEOUT_S == 30.0

    def test_otel_service_name_default_workers(self) -> None:
        # NE PAS confondre avec ai-core / retrieval / inference-router.
        assert _settings().OTEL_SERVICE_NAME == 'workers'


class TestLiteralValidation:
    def test_node_env_rejects_staging(self) -> None:
        with pytest.raises(ValidationError):
            _settings(NODE_ENV='staging')

    def test_log_level_rejects_trace(self) -> None:
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='trace')


class TestOptionalFields:
    def test_otel_endpoint_optional(self) -> None:
        assert _settings().OTEL_EXPORTER_OTLP_ENDPOINT is None


class TestGetSettingsMemoization:
    def setup_method(self) -> None:
        get_settings.cache_clear()

    def teardown_method(self) -> None:
        get_settings.cache_clear()

    def test_returns_same_instance_on_repeat_call(self) -> None:
        assert get_settings() is get_settings()

    def test_cache_clear_forces_new_instance(self) -> None:
        s1 = get_settings()
        get_settings.cache_clear()
        s2 = get_settings()
        assert s1 is not s2
