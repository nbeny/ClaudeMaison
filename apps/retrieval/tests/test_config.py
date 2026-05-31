"""Caractérisation retrieval.config — Settings pydantic + lru_cache.

Le service retrieval est le wrapper FastAPI autour de Qdrant. Les
défauts critiques à verrouiller :

  - HTTP_PORT=4100 (PAS 4000 qui est ai-core, PAS 4200 qui est
    inference-router). Régression silencieuse possible si copié.
  - QDRANT_URL=http://localhost:6333 (port Qdrant par défaut).
  - QDRANT_COLLECTION='documents' (nom canonique).
  - EMBEDDING_DIM=1024 (BGE-large-fr). MAUVAIS dim => Qdrant rejette
    en silence (ou pire, accepte et fait des matches mauvais).
  - OTEL_SERVICE_NAME='retrieval' (PAS 'ai-core').
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from retrieval.config import Settings, get_settings


def _settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[arg-type]


class TestDefaults:
    def test_node_env_default_is_development(self) -> None:
        assert _settings().NODE_ENV == 'development'

    def test_http_port_default_4100(self) -> None:
        # Contrat docker-compose : retrieval ecoute sur 4100.
        # 4000 = ai-core, 4200 = inference-router.
        assert _settings().HTTP_PORT == 4100

    def test_http_host_default_all_interfaces(self) -> None:
        assert _settings().HTTP_HOST == '0.0.0.0'

    def test_log_level_default_info(self) -> None:
        assert _settings().LOG_LEVEL == 'info'

    def test_qdrant_url_default_localhost_6333(self) -> None:
        # Port Qdrant HTTP officiel. 6334 = gRPC ; ne pas melanger.
        assert _settings().QDRANT_URL == 'http://localhost:6333'

    def test_qdrant_collection_default_documents(self) -> None:
        # Nom canonique partage avec les workers d'ingestion.
        assert _settings().QDRANT_COLLECTION == 'documents'

    def test_embedding_dim_default_1024(self) -> None:
        # BGE-large-fr produit du 1024. Mismatch 768 => qdrant rejette
        # ou pire accepte et donne des matches aleatoires.
        assert _settings().EMBEDDING_DIM == 1024

    def test_otel_service_name_default_retrieval(self) -> None:
        # NE PAS confondre avec ai-core ou inference-router.
        assert _settings().OTEL_SERVICE_NAME == 'retrieval'


class TestLiteralValidation:
    def test_node_env_accepts_test(self) -> None:
        assert _settings(NODE_ENV='test').NODE_ENV == 'test'

    def test_node_env_accepts_production(self) -> None:
        assert _settings(NODE_ENV='production').NODE_ENV == 'production'

    def test_node_env_rejects_staging(self) -> None:
        with pytest.raises(ValidationError):
            _settings(NODE_ENV='staging')

    def test_log_level_accepts_debug(self) -> None:
        assert _settings(LOG_LEVEL='debug').LOG_LEVEL == 'debug'

    def test_log_level_rejects_trace(self) -> None:
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='trace')

    def test_log_level_rejects_uppercase(self) -> None:
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='INFO')


class TestPortRange:
    def test_http_port_rejects_zero(self) -> None:
        with pytest.raises(ValidationError):
            _settings(HTTP_PORT=0)

    def test_http_port_rejects_negative(self) -> None:
        with pytest.raises(ValidationError):
            _settings(HTTP_PORT=-1)

    def test_http_port_rejects_overflow(self) -> None:
        with pytest.raises(ValidationError):
            _settings(HTTP_PORT=65_536)

    def test_http_port_accepts_max_65535(self) -> None:
        assert _settings(HTTP_PORT=65_535).HTTP_PORT == 65_535


class TestOptionalFields:
    def test_otel_endpoint_optional(self) -> None:
        assert _settings().OTEL_EXPORTER_OTLP_ENDPOINT is None

    def test_qdrant_api_key_optional(self) -> None:
        # Dev local sans auth doit passer. Prod (Qdrant Cloud) la fournit.
        assert _settings().QDRANT_API_KEY is None


class TestGetSettingsMemoization:
    def setup_method(self) -> None:
        get_settings.cache_clear()

    def teardown_method(self) -> None:
        get_settings.cache_clear()

    def test_returns_same_instance_on_repeat_call(self) -> None:
        s1 = get_settings()
        s2 = get_settings()
        assert s1 is s2

    def test_cache_info_shows_a_hit_on_second_call(self) -> None:
        get_settings()
        get_settings()
        info = get_settings.cache_info()
        assert info.hits >= 1
        assert info.misses == 1

    def test_cache_clear_forces_new_instance(self) -> None:
        s1 = get_settings()
        get_settings.cache_clear()
        s2 = get_settings()
        assert s1 is not s2
