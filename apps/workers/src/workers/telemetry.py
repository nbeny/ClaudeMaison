"""OTel SDK — no-op si OTLP endpoint absent."""

from __future__ import annotations

import os

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.semconv.resource import ResourceAttributes

_started = False


def start_telemetry() -> None:
    global _started
    if _started:
        return
    endpoint = os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')
    if not endpoint:
        return

    resource = Resource.create(
        {
            ResourceAttributes.SERVICE_NAME: os.environ.get('OTEL_SERVICE_NAME', 'workers'),
            ResourceAttributes.SERVICE_VERSION: os.environ.get('GIT_COMMIT', 'dev'),
            ResourceAttributes.DEPLOYMENT_ENVIRONMENT: os.environ.get('NODE_ENV', 'development'),
        }
    )
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f'{endpoint}/v1/traces'))
    )
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(
        MeterProvider(
            resource=resource,
            metric_readers=[
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(endpoint=f'{endpoint}/v1/metrics'),
                    export_interval_millis=15_000,
                )
            ],
        )
    )

    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.redis import RedisInstrumentor

    HTTPXClientInstrumentor().instrument()
    RedisInstrumentor().instrument()

    _started = True
