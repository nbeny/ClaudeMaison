"""Tests pour ai_core.config.

Verrouille les invariants du loader pydantic-settings :

    - Literal validation NODE_ENV / LOG_LEVEL (anti-typo en prod)
    - Port ranges 1-65535 (anti-port zéro / overflow uint16)
    - Defaults stables (dev expérience reproductible)
    - get_settings() mémoïsé via lru_cache (anti-re-parse à chaque requête)

Pydantic fait l'essentiel de la validation via annotations + Field,
mais la valeur ajoutée du test est de prouver que :

  1. les contraintes critiques (port, literal) JETTENT sans fallback
     silencieux. Un fallback à `info` pour un LOG_LEVEL inconnu ferait
     perdre tout l'intérêt du type Literal.

  2. les défauts ne dérivent pas (changer HTTP_PORT 4000 → 4001 change
     le contrat docker-compose, à valider).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ai_core.config import Settings, get_settings


def _settings(**overrides: object) -> Settings:
    """Helper : Settings sans toucher au .env du repo (ignore env_file).

    On passe les overrides directement au constructeur en bypassant la
    lecture .env. Sinon, un .env local pourrait masquer un test.
    """

    return Settings(_env_file=None, **overrides)  # type: ignore[arg-type]


class TestDefaults:
    def test_node_env_default_is_development(self) -> None:
        assert _settings().NODE_ENV == 'development'

    def test_http_port_default_4000(self) -> None:
        # Contrat docker-compose : ai-core écoute sur 4000.
        assert _settings().HTTP_PORT == 4000

    def test_grpc_port_default_5002(self) -> None:
        # Contrat docker-compose : ai-core gRPC sur 5002 (5001 = edge-api).
        assert _settings().GRPC_PORT == 5002

    def test_http_host_default_all_interfaces(self) -> None:
        # Bind sur 0.0.0.0 sinon docker ne route pas vers le container.
        assert _settings().HTTP_HOST == '0.0.0.0'

    def test_log_level_default_info(self) -> None:
        assert _settings().LOG_LEVEL == 'info'

    def test_llm_timeout_default_120s(self) -> None:
        # Timeout long pour permettre les grosses générations Mistral.
        assert _settings().LLM_TIMEOUT_S == 120.0


class TestLiteralValidation:
    """NODE_ENV et LOG_LEVEL sont Literal — pas de fallback magique."""

    def test_node_env_accepts_test(self) -> None:
        assert _settings(NODE_ENV='test').NODE_ENV == 'test'

    def test_node_env_accepts_production(self) -> None:
        assert _settings(NODE_ENV='production').NODE_ENV == 'production'

    def test_node_env_rejects_staging(self) -> None:
        # Différent d'edge-api qui accepte 'staging' — ici pas de
        # bucket intermédiaire, on dit non explicitement.
        with pytest.raises(ValidationError):
            _settings(NODE_ENV='staging')

    def test_node_env_rejects_empty_string(self) -> None:
        with pytest.raises(ValidationError):
            _settings(NODE_ENV='')

    def test_log_level_accepts_debug(self) -> None:
        assert _settings(LOG_LEVEL='debug').LOG_LEVEL == 'debug'

    def test_log_level_rejects_trace(self) -> None:
        # Python logging n'a pas TRACE. Une typo vers 'trace' doit
        # péter au boot plutôt que silencieusement downgrader à info.
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='trace')

    def test_log_level_rejects_uppercase(self) -> None:
        # Literal est case-sensitive.
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='INFO')


class TestPortRange:
    """Field(ge=1, le=65_535) — anti-port-zéro et anti-overflow uint16."""

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

    def test_grpc_port_rejects_zero(self) -> None:
        with pytest.raises(ValidationError):
            _settings(GRPC_PORT=0)

    def test_grpc_port_rejects_overflow(self) -> None:
        with pytest.raises(ValidationError):
            _settings(GRPC_PORT=65_536)


class TestGetSettingsMemoization:
    """lru_cache(maxsize=1) — get_settings() doit renvoyer la MÊME instance."""

    def setup_method(self) -> None:
        # Vide le cache avant chaque test pour repartir propre.
        get_settings.cache_clear()

    def teardown_method(self) -> None:
        get_settings.cache_clear()

    def test_returns_same_instance_on_repeat_call(self) -> None:
        s1 = get_settings()
        s2 = get_settings()
        # Pas juste égalité — IDENTITÉ. Sinon chaque requête FastAPI
        # re-parserait l'env, ce qui en plus d'être lent peut faire
        # diverger si l'env est muté par un test.
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


class TestOptionalFields:
    """OTEL endpoint et QDRANT_API_KEY peuvent être absents."""

    def test_otel_endpoint_optional(self) -> None:
        assert _settings().OTEL_EXPORTER_OTLP_ENDPOINT is None

    def test_qdrant_api_key_optional(self) -> None:
        # Dev local sans auth : doit passer.
        assert _settings().QDRANT_API_KEY is None

    def test_otel_service_name_default_ai_core(self) -> None:
        # Identifie ce service dans les traces — ne PAS confondre avec
        # 'edge-api' ou 'realtime'.
        assert _settings().OTEL_SERVICE_NAME == 'ai-core'
