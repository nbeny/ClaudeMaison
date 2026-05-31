"""Caractérisation tools.config — Settings + lru_cache.

tools est le service gRPC d'exécution d'outils builtin (HTTP fetch,
shell sandboxed plus tard). Défauts à verrouiller :

  - GRPC_PORT=5005 (PAS 4xxx — ce sont des HTTP). Si on bascule sur
    4000/4100/4200 sans rien dire, edge-api essaiera d'ouvrir un canal
    gRPC contre du HTTP et obtiendra UNAVAILABLE.

  - TOOL_TIMEOUT_S=5.0 (plafond bas tant qu'il n'y a pas de sandbox).
    Si on monte à 60s sans sandbox Firecracker, un tool malicieux peut
    bloquer un worker entier.

  - HTTP_MAX_BYTES=1_048_576 (1 MiB). Limite anti-DoS sur les fetches
    HTTP des tools. Bumper à 100 MiB sans réfléchir = OOM possible.

  - OTEL_SERVICE_NAME='tools' (PAS 'workers' / 'ai-core').
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tools.config import Settings, get_settings


def _settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, **overrides)  # type: ignore[arg-type]


class TestDefaults:
    def test_node_env_default_is_development(self) -> None:
        assert _settings().NODE_ENV == 'development'

    def test_log_level_default_info(self) -> None:
        assert _settings().LOG_LEVEL == 'info'

    def test_grpc_port_default_5005(self) -> None:
        # Contrat docker-compose. Différent des HTTP services (4xxx).
        # Si on tape 4000 (ai-core HTTP), edge-api tenterait une
        # connexion gRPC sur du HTTP/1 et obtiendrait des erreurs
        # UNAVAILABLE sans diagnostic clair.
        assert _settings().GRPC_PORT == 5005

    def test_grpc_host_default_bind_all(self) -> None:
        # Bind 0.0.0.0 pour fonctionner dans le conteneur. Localhost
        # serait inaccessible depuis le réseau Docker.
        assert _settings().GRPC_HOST == '0.0.0.0'

    def test_tool_timeout_default_5s(self) -> None:
        # Plafond bas DELIBERE. Pas de sandbox = pas de confiance.
        # Monter ce défaut sans Firecracker = pied dans la porte
        # pour un tool qui bloque indéfiniment le worker.
        assert _settings().TOOL_TIMEOUT_S == 5.0

    def test_http_max_bytes_default_1_mib(self) -> None:
        # Limite anti-DoS sur les fetches HTTP. 1 MiB = compromis
        # entre cas d'usage (docs courts) et OOM-safety.
        assert _settings().HTTP_MAX_BYTES == 1_048_576

    def test_otel_service_name_default_tools(self) -> None:
        # NE PAS confondre avec workers/ai-core/retrieval/inference-router.
        # tools est le seul service gRPC pur du monorepo (avec billing).
        assert _settings().OTEL_SERVICE_NAME == 'tools'


class TestLiteralValidation:
    def test_node_env_rejects_staging(self) -> None:
        with pytest.raises(ValidationError):
            _settings(NODE_ENV='staging')

    def test_log_level_rejects_trace(self) -> None:
        with pytest.raises(ValidationError):
            _settings(LOG_LEVEL='trace')


class TestPortBounds:
    def test_grpc_port_rejects_zero(self) -> None:
        # ge=1 sur le Field. Port 0 = "OS pick" qui n'est pas ce qu'on
        # veut dans un container.
        with pytest.raises(ValidationError):
            _settings(GRPC_PORT=0)

    def test_grpc_port_rejects_above_65535(self) -> None:
        with pytest.raises(ValidationError):
            _settings(GRPC_PORT=65_536)

    def test_grpc_port_accepts_1(self) -> None:
        assert _settings(GRPC_PORT=1).GRPC_PORT == 1

    def test_grpc_port_accepts_max(self) -> None:
        assert _settings(GRPC_PORT=65_535).GRPC_PORT == 65_535


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
