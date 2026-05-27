"""Tests parse_model_backends — format Phase 1 avec provider/priority/auth."""

from __future__ import annotations

import pytest

from inference_router.config import BackendConfig, parse_model_backends


def test_parse_simple_url_defaults_to_llama_cpp() -> None:
    out = parse_model_backends('m1=http://x:8080')
    assert out == {
        'm1': [
            BackendConfig(url='http://x:8080', provider='llama-cpp', priority=0, api_key_env=None)
        ]
    }


def test_parse_multiple_backends_same_priority() -> None:
    out = parse_model_backends('m1=http://a,http://b')
    assert len(out['m1']) == 2
    assert {b.url for b in out['m1']} == {'http://a', 'http://b'}
    assert all(b.priority == 0 for b in out['m1'])


def test_parse_provider_prefix_and_api_key() -> None:
    spec = 'big=mistral:https://api.mistral.ai|env:MISTRAL_API_KEY'
    out = parse_model_backends(spec)
    assert out['big'][0].provider == 'mistral'
    assert out['big'][0].api_key_env == 'MISTRAL_API_KEY'
    assert out['big'][0].url == 'https://api.mistral.ai'


def test_parse_priority_via_pipe() -> None:
    out = parse_model_backends('m=http://primary|prio:0,http://fallback|prio:1')
    by_prio = {b.url: b.priority for b in out['m']}
    assert by_prio == {'http://primary': 0, 'http://fallback': 1}


def test_parse_rejects_empty_url() -> None:
    with pytest.raises(ValueError):
        parse_model_backends('m=')
