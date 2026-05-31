"""Tests start_telemetry — bootstrap OTel côté Python (parallèle d'edge-api).

Invariants :

  - No-op si OTEL_EXPORTER_OTLP_ENDPOINT absent. Dev local sans
    collector ne doit pas planter au boot.

  - Idempotence via flag module-level `_started`. Sans ça, deux SDK
    enregistrés en parallèle → double export, fuites.

  - URLs : trace = endpoint + '/v1/traces', metric = endpoint + '/v1/metrics'.
    Convention OTLP HTTP — un suffixe faux fait 404 silencieux côté
    collector, on perd toutes les traces sans diagnostic.

  - Defaults Resource : service.name='ai-core' (sinon traces sous
    'unknown_service' dans Grafana), service.version='dev',
    deployment.environment='development'.

  - export_interval_millis = 15_000. Trop court flood le collector,
    trop long perd des métriques en cas de crash.

  - Instrumentations sélectives : FastAPIInstrumentor + HTTPXClientInstrumentor
    + GrpcInstrumentorServer. PAS d'auto-instrumentation globale (éviterait
    de patcher des libs non utilisées, garderait le bundle déterministe).

  - get_tracer / get_meter : passe-plat vers OTel API. Fournissent un
    no-op handle si telemetry pas démarrée (contrat OTel API standard).
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def reset_telemetry() -> Any:
    """Reset le flag _started entre tests pour pouvoir re-démarrer."""
    from ai_core import telemetry as t

    saved = t._started
    t._started = False
    yield t
    t._started = saved


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    monkeypatch.delenv('OTEL_SERVICE_NAME', raising=False)
    monkeypatch.delenv('GIT_COMMIT', raising=False)
    monkeypatch.delenv('NODE_ENV', raising=False)


@pytest.fixture
def with_endpoint(monkeypatch: pytest.MonkeyPatch, clean_env: None) -> str:
    endpoint = 'http://otel-collector:4318'
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', endpoint)
    return endpoint


class TestNoEndpoint:
    """Sans endpoint, start_telemetry doit être totalement inerte."""

    def test_no_op_when_endpoint_missing(
        self, reset_telemetry: Any, clean_env: None
    ) -> None:
        with (
            patch('ai_core.telemetry.TracerProvider') as tracer,
            patch('ai_core.telemetry.MeterProvider') as meter,
        ):
            reset_telemetry.start_telemetry()
        tracer.assert_not_called()
        meter.assert_not_called()

    def test_started_flag_stays_false_when_no_endpoint(
        self, reset_telemetry: Any, clean_env: None
    ) -> None:
        # Sans ce contrat, un appel ultérieur avec endpoint configuré
        # serait bloqué à jamais par l'idempotence-guard.
        reset_telemetry.start_telemetry()
        assert reset_telemetry._started is False

    def test_no_op_when_endpoint_is_empty_string(
        self, reset_telemetry: Any, clean_env: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Important : '' compte comme absent (truthy guard). Sinon
        # l'exporter explose sur URL invalide.
        monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
        with patch('ai_core.telemetry.TracerProvider') as tracer:
            reset_telemetry.start_telemetry()
        tracer.assert_not_called()


class TestBootstrap:
    """Avec endpoint, on initialise traces + métriques + instrumentations."""

    def test_creates_tracer_provider(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        with (
            patch('ai_core.telemetry.TracerProvider') as tracer,
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        tracer.assert_called_once()

    def test_creates_meter_provider(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        with (
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider') as meter,
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        meter.assert_called_once()

    def test_sets_started_flag_to_True(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        with (
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        assert reset_telemetry._started is True


class TestUrls:
    def test_trace_exporter_uses_v1_traces_suffix(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        # 404 silencieux côté collector si on se trompe — pire :
        # les spans sont droppés sans erreur visible.
        with (
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter') as span_exporter,
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        span_exporter.assert_called_once()
        _, kwargs = span_exporter.call_args
        assert kwargs == {'endpoint': f'{with_endpoint}/v1/traces'}

    def test_metric_exporter_uses_v1_metrics_suffix(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        with (
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter') as metric_exporter,
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        metric_exporter.assert_called_once()
        _, kwargs = metric_exporter.call_args
        assert kwargs == {'endpoint': f'{with_endpoint}/v1/metrics'}


class TestExportInterval:
    def test_export_interval_is_15_000_ms(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        # Compromis prod : pas de flood, pas de perte massive.
        with (
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader') as reader,
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
        reader.assert_called_once()
        _, kwargs = reader.call_args
        assert kwargs['export_interval_millis'] == 15_000


class TestResourceDefaults:
    def _run(self, reset_telemetry: Any, captured: dict[str, Any]) -> None:
        # Capture le dict passé à Resource.create.
        def _spy(attrs: dict[str, Any]) -> Any:
            captured['attrs'] = attrs
            return MagicMock()

        with (
            patch('ai_core.telemetry.Resource.create', side_effect=_spy),
            patch('ai_core.telemetry.TracerProvider'),
            patch('ai_core.telemetry.MeterProvider'),
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()

    def test_service_name_defaults_to_ai_core(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        # Sans ce fallback, les traces apparaîtraient sous
        # service.name='unknown_service' dans Grafana → debug
        # impossible en multi-service.
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        # ResourceAttributes.SERVICE_NAME == 'service.name'
        assert captured['attrs']['service.name'] == 'ai-core'

    def test_service_version_defaults_to_dev(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        assert captured['attrs']['service.version'] == 'dev'

    def test_deployment_environment_defaults_to_development(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        assert captured['attrs']['deployment.environment'] == 'development'

    def test_OTEL_SERVICE_NAME_env_overrides_default(
        self, reset_telemetry: Any, with_endpoint: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv('OTEL_SERVICE_NAME', 'ai-core-canary')
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        assert captured['attrs']['service.name'] == 'ai-core-canary'

    def test_GIT_COMMIT_env_overrides_version_default(
        self, reset_telemetry: Any, with_endpoint: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv('GIT_COMMIT', 'feedf00d')
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        assert captured['attrs']['service.version'] == 'feedf00d'

    def test_NODE_ENV_overrides_environment_default(
        self, reset_telemetry: Any, with_endpoint: str,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv('NODE_ENV', 'production')
        captured: dict[str, Any] = {}
        self._run(reset_telemetry, captured)
        assert captured['attrs']['deployment.environment'] == 'production'


class TestIdempotence:
    def test_second_call_is_no_op(
        self, reset_telemetry: Any, with_endpoint: str
    ) -> None:
        # Sans le guard `if _started: return`, deux SDK enregistrés en
        # parallèle = double export, leaks, et potentiellement des
        # subspan dupliqués côté collector.
        with (
            patch('ai_core.telemetry.TracerProvider') as tracer,
            patch('ai_core.telemetry.MeterProvider') as meter,
            patch('ai_core.telemetry.OTLPSpanExporter'),
            patch('ai_core.telemetry.OTLPMetricExporter'),
            patch('ai_core.telemetry.PeriodicExportingMetricReader'),
            patch('ai_core.telemetry.BatchSpanProcessor'),
            patch('ai_core.telemetry.trace'),
            patch('ai_core.telemetry.metrics'),
            patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
            patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
            patch('opentelemetry.instrumentation.grpc.GrpcInstrumentorServer'),
        ):
            reset_telemetry.start_telemetry()
            reset_telemetry.start_telemetry()
        # Un seul appel à TracerProvider/MeterProvider malgré 2 starts.
        assert tracer.call_count == 1
        assert meter.call_count == 1


class TestAccessors:
    """get_tracer/get_meter sont des passe-plat vers l'API OTel — ils
    fonctionnent même sans telemetry démarrée (no-op providers)."""

    def test_get_tracer_returns_tracer_instance(self) -> None:
        from ai_core import telemetry
        tracer = telemetry.get_tracer('test.module')
        # L'API OTel renvoie toujours un Tracer (no-op si SDK absent).
        assert tracer is not None
        assert hasattr(tracer, 'start_span')

    def test_get_meter_returns_meter_instance(self) -> None:
        from ai_core import telemetry
        meter = telemetry.get_meter('test.module')
        assert meter is not None
        # API OTel Meter expose create_counter au minimum.
        assert hasattr(meter, 'create_counter')
