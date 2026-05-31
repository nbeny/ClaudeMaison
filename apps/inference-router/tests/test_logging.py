"""Caractérisation inference_router.logging — structlog setup.

Calque sur ai-core/logging.py. Pas de différences attendues :
même structure, même pipeline, même switching dev/prod.
"""

from __future__ import annotations

import logging
from typing import Any
from unittest.mock import patch

import pytest
import structlog

from inference_router import config, logging as ilogging


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> None:
    config.get_settings.cache_clear()


def _patch_settings(**overrides: Any) -> Any:
    def _factory() -> config.Settings:
        return config.Settings(_env_file=None, **overrides)  # type: ignore[call-arg]
    return patch('inference_router.logging.get_settings', side_effect=_factory)


def _capture_configure() -> Any:
    captured: dict[str, Any] = {}

    def _spy(**kw: Any) -> None:
        captured.update(kw)

    return patch('structlog.configure', side_effect=_spy), captured


def _capture_basic_config() -> Any:
    captured: dict[str, Any] = {}

    def _spy(**kw: Any) -> None:
        captured.update(kw)

    return patch('logging.basicConfig', side_effect=_spy), captured


class TestLevelResolution:
    def test_info(self) -> None:
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='info'), bc, cfg:
            ilogging.configure_logging()
        assert bcc['level'] == logging.INFO

    def test_debug(self) -> None:
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='debug'), bc, cfg:
            ilogging.configure_logging()
        assert bcc['level'] == logging.DEBUG

    def test_warning(self) -> None:
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='warning'), bc, cfg:
            ilogging.configure_logging()
        assert bcc['level'] == logging.WARNING

    def test_error(self) -> None:
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='error'), bc, cfg:
            ilogging.configure_logging()
        assert bcc['level'] == logging.ERROR


class TestBasicConfig:
    def test_stream_is_stdout(self) -> None:
        # K8s convention : stdout → forwarders, stderr → process diagnostics.
        # Pattern sentinel-objects pour bypass colorama+pytest qui wrappent stdout.
        sentinel_stdout = object()
        sentinel_stderr = object()
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with (
            _patch_settings(),
            bc,
            cfg,
            patch.object(ilogging.sys, 'stdout', sentinel_stdout),
            patch.object(ilogging.sys, 'stderr', sentinel_stderr),
        ):
            ilogging.configure_logging()
        assert bcc['stream'] is sentinel_stdout
        assert bcc['stream'] is not sentinel_stderr

    def test_format_is_message_only(self) -> None:
        bc, bcc = _capture_basic_config()
        cfg, _ = _capture_configure()
        with _patch_settings(), bc, cfg:
            ilogging.configure_logging()
        assert bcc['format'] == '%(message)s'


class TestRendererSelection:
    def test_development_uses_ConsoleRenderer(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(NODE_ENV='development'), bc, cfg:
            ilogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.dev.ConsoleRenderer)

    def test_production_uses_JSONRenderer(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(NODE_ENV='production'), bc, cfg:
            ilogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.processors.JSONRenderer)

    def test_test_env_uses_JSONRenderer(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(NODE_ENV='test'), bc, cfg:
            ilogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.processors.JSONRenderer)


class TestProcessorChain:
    def test_renderer_is_last(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(NODE_ENV='production'), bc, cfg:
            ilogging.configure_logging()
        assert isinstance(captured['processors'][-1], structlog.processors.JSONRenderer)

    def test_merge_contextvars_is_first(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(), bc, cfg:
            ilogging.configure_logging()
        assert captured['processors'][0] is structlog.contextvars.merge_contextvars

    def test_chain_contains_timestamper(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(), bc, cfg:
            ilogging.configure_logging()
        assert any(isinstance(p, structlog.processors.TimeStamper) for p in captured['processors'])

    def test_chain_contains_log_level(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(), bc, cfg:
            ilogging.configure_logging()
        assert structlog.stdlib.add_log_level in captured['processors']


class TestWrapperAndCache:
    def test_cache_logger_on_first_use_True(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(), bc, cfg:
            ilogging.configure_logging()
        assert captured['cache_logger_on_first_use'] is True

    def test_wrapper_class_is_set(self) -> None:
        bc, _ = _capture_basic_config()
        cfg, captured = _capture_configure()
        with _patch_settings(LOG_LEVEL='warning'), bc, cfg:
            ilogging.configure_logging()
        assert captured['wrapper_class'] is not None


class TestGetLogger:
    def test_returns_bound_logger(self) -> None:
        log = ilogging.get_logger('test.module')
        assert hasattr(log, 'info')
        assert callable(log.info)

    def test_None_name_does_not_raise(self) -> None:
        log = ilogging.get_logger(None)
        assert log is not None
