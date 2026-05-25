"""Tests du round-robin."""

from __future__ import annotations

import pytest

from inference_router.config import parse_model_backends
from inference_router.router import BackendRouter


def test_round_robin_cycles_in_order() -> None:
    r = BackendRouter({'m': ['a', 'b', 'c']})
    picks = [r.pick('m') for _ in range(7)]
    assert picks == ['a', 'b', 'c', 'a', 'b', 'c', 'a']


def test_unknown_model_raises() -> None:
    r = BackendRouter({'m': ['a']})
    with pytest.raises(KeyError):
        r.pick('nope')


def test_models_listing_is_sorted() -> None:
    r = BackendRouter({'b': ['x'], 'a': ['y']})
    assert r.models() == ['a', 'b']


def test_parse_model_backends_basic() -> None:
    out = parse_model_backends('m1=http://a,http://b;m2=http://c')
    assert out == {'m1': ['http://a', 'http://b'], 'm2': ['http://c']}


def test_parse_model_backends_empty() -> None:
    assert parse_model_backends('') == {}


def test_parse_model_backends_rejects_invalid() -> None:
    with pytest.raises(ValueError):
        parse_model_backends('m1')
    with pytest.raises(ValueError):
        parse_model_backends('m1=')
