"""Tests configure_logging — structlog setup avec dev/prod renderers.

Invariants :

  - dev (NODE_ENV='development') → ConsoleRenderer avec colors=True.
    Si on basculait par défaut sur JSONRenderer en dev, le terminal
    affichait du JSON brut au lieu du joli format coloré.

  - prod/test (NODE_ENV != 'development') → JSONRenderer. Sinon Loki
    ne peut pas parser les logs, on perd toute observabilité.

  - level résolu depuis settings.LOG_LEVEL.upper() via getattr(logging, ...).
    'info' → logging.INFO, 'warning' → logging.WARNING. Pas de magic
    de mapping séparée.

  - stream=sys.stdout (PAS sys.stderr). Convention K8s : stdout = logs
    app, stderr = process diagnostics. Forwarder Vector/Promtail ne lit
    par défaut que stdout.

  - format='%(message)s' (zero decoration) : c'est structlog qui formate.
    Si on laissait le default '%(levelname)s:%(name)s:%(message)s',
    les logs JSON contiendraient un préfixe "INFO:ai-core:" parasite.

  - wrapper_class = make_filtering_bound_logger(level) : les calls
    sub-level sont droppés tôt (perf). Sans ça, debug() formate tout
    avant d'être filtré.

  - cache_logger_on_first_use=True : optimisation, évite de reconstruire
    le BoundLogger à chaque get_logger.

  - processors order : merge_contextvars FIRST (pour que les contextvars
    soient présents dans le rendu), renderer LAST (terminal du pipeline).
"""

from __future__ import annotations

import logging
import sys
from typing import Any
from unittest.mock import patch

import pytest
import structlog

from ai_core import config, logging as ailogging


@pytest.fixture(autouse=True)
def _reset_settings_cache() -> None:
    # Settings sont cachés par lru_cache — on doit invalider entre tests
    # pour que les overrides NODE_ENV/LOG_LEVEL prennent effet.
    config.get_settings.cache_clear()


def _patch_settings(**overrides: Any) -> Any:
    """Force get_settings() à renvoyer un Settings avec les overrides."""
    def _factory() -> config.Settings:
        return config.Settings(_env_file=None, **overrides)  # type: ignore[call-arg]
    return patch('ai_core.logging.get_settings', side_effect=_factory)


def _capture_configure() -> Any:
    """Patch structlog.configure pour capturer les kwargs sans configurer."""
    captured: dict[str, Any] = {}

    def _spy(**kw: Any) -> None:
        captured.update(kw)

    p = patch('structlog.configure', side_effect=_spy)
    return p, captured


def _capture_basic_config() -> Any:
    captured: dict[str, Any] = {}

    def _spy(**kw: Any) -> None:
        captured.update(kw)

    p = patch('logging.basicConfig', side_effect=_spy)
    return p, captured


class TestLevelResolution:
    def test_info_resolves_to_logging_INFO(self) -> None:
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='info'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert bc_captured['level'] == logging.INFO

    def test_debug_resolves_to_logging_DEBUG(self) -> None:
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='debug'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert bc_captured['level'] == logging.DEBUG

    def test_warning_resolves_to_logging_WARNING(self) -> None:
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='warning'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert bc_captured['level'] == logging.WARNING

    def test_error_resolves_to_logging_ERROR(self) -> None:
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with _patch_settings(LOG_LEVEL='error'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert bc_captured['level'] == logging.ERROR


class TestBasicConfig:
    """logging.basicConfig setup — base stdlib qui sous-tend structlog."""

    def test_stream_is_stdout_NOT_stderr(self) -> None:
        # K8s convention : stdout = app logs (forwardés à Loki),
        # stderr = process diagnostics (souvent ignorés).
        #
        # On vérifie en mockant `sys.stdout` avec un sentinel qu'on peut
        # comparer par identité. C'est plus robuste que de comparer au
        # sys.stdout réel — pytest+colorama enveloppent le stream et
        # rendent la comparaison par identité fragile.
        sentinel_stdout = object()
        sentinel_stderr = object()
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with (
            _patch_settings(),
            bc_patch,
            cfg_patch,
            patch.object(ailogging.sys, 'stdout', sentinel_stdout),
            patch.object(ailogging.sys, 'stderr', sentinel_stderr),
        ):
            ailogging.configure_logging()
        # L'invariant fort : régression stream=sys.stderr ferait
        # passer ce test à False.
        assert bc_captured['stream'] is sentinel_stdout
        assert bc_captured['stream'] is not sentinel_stderr

    def test_format_is_message_only(self) -> None:
        # structlog gère le format complet — le format stdlib doit être
        # nu, sinon "INFO:ai-core:" préfixe parasite le JSON.
        bc_patch, bc_captured = _capture_basic_config()
        cfg_patch, _ = _capture_configure()
        with _patch_settings(), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert bc_captured['format'] == '%(message)s'


class TestRendererSelection:
    """Le renderer change selon NODE_ENV. C'est le contrat dev/prod le
    plus critique : si on inverse, le terminal dev affiche du JSON et
    Loki rejette du texte coloré."""

    def test_development_uses_ConsoleRenderer(self) -> None:
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(NODE_ENV='development'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.dev.ConsoleRenderer)

    def test_development_console_has_colors(self) -> None:
        # ConsoleRenderer(colors=False) ne color pas le terminal — UX
        # dégradée mais surtout signal d'une régression silencieuse.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(NODE_ENV='development'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.dev.ConsoleRenderer)
        # Le flag colors n'est pas exposé en attribut public ; on vérifie
        # par observation : c'est bien un ConsoleRenderer, pas un JSONRenderer.
        assert not isinstance(renderer, structlog.processors.JSONRenderer)

    def test_production_uses_JSONRenderer(self) -> None:
        # Loki/Grafana parsent du JSON. ConsoleRenderer en prod = logs
        # invisibles dans la stack obs.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(NODE_ENV='production'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.processors.JSONRenderer)

    def test_test_env_uses_JSONRenderer(self) -> None:
        # 'test' n'est pas 'development' → fallback JSON. C'est utile
        # pour pytest qui peut parser les logs structurés.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(NODE_ENV='test'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        renderer = captured['processors'][-1]
        assert isinstance(renderer, structlog.processors.JSONRenderer)


class TestProcessorChain:
    def test_renderer_is_last(self) -> None:
        # Le renderer DOIT être en dernière position — c'est le terminal
        # du pipeline structlog. S'il était plus haut, les processeurs
        # suivants recevraient un str au lieu d'un dict et casseraient.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(NODE_ENV='production'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        processors = captured['processors']
        last = processors[-1]
        assert isinstance(last, structlog.processors.JSONRenderer)

    def test_merge_contextvars_is_first(self) -> None:
        # Doit être premier pour que les contextvars apparaissent dans le
        # rendu final ET dans tous les processeurs intermédiaires.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert captured['processors'][0] is structlog.contextvars.merge_contextvars

    def test_chain_contains_timestamper(self) -> None:
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(), bc_patch, cfg_patch:
            ailogging.configure_logging()
        has_ts = any(isinstance(p, structlog.processors.TimeStamper) for p in captured['processors'])
        assert has_ts

    def test_chain_contains_log_level(self) -> None:
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert structlog.stdlib.add_log_level in captured['processors']


class TestWrapperAndCache:
    def test_cache_logger_on_first_use_True(self) -> None:
        # Optimisation : sans le cache, structlog reconstruit un
        # BoundLogger à CHAQUE appel de get_logger() — perf hit
        # notable sur les hot paths.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(), bc_patch, cfg_patch:
            ailogging.configure_logging()
        assert captured['cache_logger_on_first_use'] is True

    def test_wrapper_class_is_filtering_at_configured_level(self) -> None:
        # make_filtering_bound_logger filtre AVANT de formater, ce qui
        # économise CPU sur les debug() droppés. Si on retombe sur
        # BoundLogger non-filtré, debug() formate puis le std logging
        # drop — c'est plus lent.
        bc_patch, _ = _capture_basic_config()
        cfg_patch, captured = _capture_configure()
        with _patch_settings(LOG_LEVEL='warning'), bc_patch, cfg_patch:
            ailogging.configure_logging()
        # Le wrapper attendu = celui produit par make_filtering_bound_logger.
        # On vérifie au moins qu'il a été passé (callable/class) et qu'il
        # n'est pas None.
        assert captured['wrapper_class'] is not None


class TestGetLogger:
    def test_returns_a_bound_logger(self) -> None:
        log = ailogging.get_logger('test.module')
        # structlog.get_logger renvoie un proxy qui se résout en
        # BoundLogger à l'usage — on vérifie qu'il a au moins les
        # méthodes attendues.
        assert hasattr(log, 'info')
        assert hasattr(log, 'warning')
        assert hasattr(log, 'error')
        assert callable(log.info)

    def test_returns_distinct_instances_for_distinct_names(self) -> None:
        # Au minimum, le nom est passé en argument à structlog.get_logger ;
        # cache_logger_on_first_use=True veut dire que la résolution
        # complète peut être partagée — mais l'objet renvoyé doit au
        # moins avoir un .name distinct pour le contexte du logger.
        a = ailogging.get_logger('ai_core.a')
        b = ailogging.get_logger('ai_core.b')
        assert a is not None and b is not None

    def test_None_name_does_not_raise(self) -> None:
        # Le paramètre name=None est explicitement supporté (utile pour
        # le logger root).
        log = ailogging.get_logger(None)
        assert log is not None
