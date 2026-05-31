"""Caractérisation inference_router.telemetry — bootstrap OTel.

Calque sur ai-core/telemetry.py avec deux différences à verrouiller :

  - Default service.name = 'inference-router' (PAS 'ai-core'). Copier
    le fichier sans changer le default ferait que les traces apparaissent
    sous service.name=ai-core dans Grafana, cassant la corrélation
    multi-service.

  - Instrumentations RESTREINTES à FastAPI + httpx. PAS de gRPC
    (inference-router ne sert pas de gRPC, il proxie en HTTP). Si on
    rajoutait GrpcInstrumentor, on patcherait un module qu'on n'utilise
    pas et on traînerait une dep inutile.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from inference_router import telemetry as t


@pytest.fixture
def reset_telemetry() -> Any:
    saved = t._started
    t._started = False
    yield t
    t._started = saved


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in ('OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SERVICE_NAME', 'GIT_COMMIT', 'NODE_ENV'):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def with_endpoint(monkeypatch: pytest.MonkeyPatch, clean_env: None) -> None:
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://otel-collector:4318')


def _patches() -> Any:
    """Contexte multi-patch pour bypass tout effet de bord OTel global."""
    return [
        patch('inference_router.telemetry.TracerProvider'),
        patch('inference_router.telemetry.MeterProvider'),
        patch('inference_router.telemetry.OTLPSpanExporter'),
        patch('inference_router.telemetry.OTLPMetricExporter'),
        patch('inference_router.telemetry.PeriodicExportingMetricReader'),
        patch('inference_router.telemetry.BatchSpanProcessor'),
        patch('inference_router.telemetry.trace'),
        patch('inference_router.telemetry.metrics'),
        patch('opentelemetry.instrumentation.fastapi.FastAPIInstrumentor'),
        patch('opentelemetry.instrumentation.httpx.HTTPXClientInstrumentor'),
    ]


def _resource_spy() -> Any:
    """Spy sur Resource.create pour capturer les attrs."""
    captured: dict[str, Any] = {}

    def _fake(attrs: dict[str, Any]) -> object:
        captured['attrs'] = attrs
        return object()

    p = patch('inference_router.telemetry.Resource.create', side_effect=_fake)
    return p, captured


class TestNoEndpoint:
    def test_no_op_when_endpoint_missing(
        self, reset_telemetry: Any, clean_env: None
    ) -> None:
        patches = _patches()
        with patches[0] as TP:
            for p in patches[1:]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                assert not TP.called
            finally:
                for p in patches[1:]:
                    p.stop()

    def test_started_flag_stays_false_when_no_endpoint(
        self, reset_telemetry: Any, clean_env: None
    ) -> None:
        reset_telemetry.start_telemetry()
        assert reset_telemetry._started is False

    def test_no_op_when_endpoint_is_empty_string(
        self, reset_telemetry: Any, clean_env: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', '')
        patches = _patches()
        with patches[0] as TP:
            for p in patches[1:]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                assert not TP.called
            finally:
                for p in patches[1:]:
                    p.stop()


class TestBootstrap:
    def test_creates_tracer_provider(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[0] as TP:
            for p in patches[1:]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                assert TP.called
            finally:
                for p in patches[1:]:
                    p.stop()

    def test_creates_meter_provider(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[1] as MP:
            for p in [patches[0], *patches[2:]]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                assert MP.called
            finally:
                for p in [patches[0], *patches[2:]]:
                    p.stop()

    def test_sets_started_flag(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        for p in patches:
            p.start()
        try:
            reset_telemetry.start_telemetry()
            assert reset_telemetry._started is True
        finally:
            for p in patches:
                p.stop()


class TestUrls:
    def test_trace_exporter_uses_v1_traces_suffix(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[2] as Trace:
            for p in [*patches[0:2], *patches[3:]]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                Trace.assert_called_with(endpoint='http://otel-collector:4318/v1/traces')
            finally:
                for p in [*patches[0:2], *patches[3:]]:
                    p.stop()

    def test_metric_exporter_uses_v1_metrics_suffix(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[3] as Metric:
            for p in [*patches[0:3], *patches[4:]]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                Metric.assert_called_with(endpoint='http://otel-collector:4318/v1/metrics')
            finally:
                for p in [*patches[0:3], *patches[4:]]:
                    p.stop()


class TestExportInterval:
    def test_export_interval_is_15_000_ms(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[4] as Reader:
            for p in [*patches[0:4], *patches[5:]]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                _, kwargs = Reader.call_args
                assert kwargs['export_interval_millis'] == 15_000
            finally:
                for p in [*patches[0:4], *patches[5:]]:
                    p.stop()


class TestResourceDefaults:
    def test_service_name_defaults_to_inference_router(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        # Régression CRITIQUE possible : copier/coller depuis ai-core
        # sans changer le default ferait apparaître les traces du router
        # sous service.name=ai-core. La corrélation multi-service serait
        # cassée silencieusement.
        spy_p, captured = _resource_spy()
        patches = _patches()
        for p in patches:
            p.start()
        with spy_p:
            try:
                reset_telemetry.start_telemetry()
            finally:
                for p in patches:
                    p.stop()
        assert captured['attrs']['service.name'] == 'inference-router'
        assert captured['attrs']['service.name'] != 'ai-core'

    def test_service_version_defaults_to_dev(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        spy_p, captured = _resource_spy()
        patches = _patches()
        for p in patches:
            p.start()
        with spy_p:
            try:
                reset_telemetry.start_telemetry()
            finally:
                for p in patches:
                    p.stop()
        assert captured['attrs']['service.version'] == 'dev'

    def test_deployment_environment_defaults_to_development(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        spy_p, captured = _resource_spy()
        patches = _patches()
        for p in patches:
            p.start()
        with spy_p:
            try:
                reset_telemetry.start_telemetry()
            finally:
                for p in patches:
                    p.stop()
        assert captured['attrs']['deployment.environment'] == 'development'

    def test_OTEL_SERVICE_NAME_env_overrides_default(
        self, reset_telemetry: Any, with_endpoint: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv('OTEL_SERVICE_NAME', 'inference-router-canary')
        spy_p, captured = _resource_spy()
        patches = _patches()
        for p in patches:
            p.start()
        with spy_p:
            try:
                reset_telemetry.start_telemetry()
            finally:
                for p in patches:
                    p.stop()
        assert captured['attrs']['service.name'] == 'inference-router-canary'


class TestIdempotence:
    def test_second_call_is_no_op(
        self, reset_telemetry: Any, with_endpoint: None
    ) -> None:
        patches = _patches()
        with patches[0] as TP:
            for p in patches[1:]:
                p.start()
            try:
                reset_telemetry.start_telemetry()
                reset_telemetry.start_telemetry()
                assert TP.call_count == 1
            finally:
                for p in patches[1:]:
                    p.stop()
