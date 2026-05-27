"""Tests BackendRouter — priorité + round-robin."""

from __future__ import annotations

import pytest

from inference_router.config import BackendConfig
from inference_router.router import BackendRouter


def _bc(url: str, prio: int = 0) -> BackendConfig:
    return BackendConfig(url=url, priority=prio)


def test_attempts_returns_one_pick_per_priority_group() -> None:
    router = BackendRouter({'m': [_bc('http://a', 0), _bc('http://b', 0), _bc('http://c', 1)]})
    picks = router.attempts('m')
    assert len(picks) == 2
    assert picks[0].group_index == 0
    assert picks[1].group_index == 1
    assert picks[0].backend.url in {'http://a', 'http://b'}
    assert picks[1].backend.url == 'http://c'


def test_round_robin_within_same_priority() -> None:
    router = BackendRouter({'m': [_bc('http://a'), _bc('http://b')]})
    seen = {router.attempts('m')[0].backend.url for _ in range(4)}
    # Au moins une fois chaque sur 4 tirages.
    assert seen == {'http://a', 'http://b'}


def test_round_robin_cycles_in_order_within_group() -> None:
    router = BackendRouter({'m': [_bc('http://a'), _bc('http://b'), _bc('http://c')]})
    picks = [router.attempts('m')[0].backend.url for _ in range(7)]
    assert picks == [
        'http://a',
        'http://b',
        'http://c',
        'http://a',
        'http://b',
        'http://c',
        'http://a',
    ]


def test_unknown_model_raises() -> None:
    router = BackendRouter({'m': [_bc('http://a')]})
    with pytest.raises(KeyError):
        router.attempts('does-not-exist')


def test_models_listing_is_sorted() -> None:
    router = BackendRouter({'b': [_bc('http://x')], 'a': [_bc('http://y')]})
    assert router.models() == ['a', 'b']


def test_priority_order_across_three_groups() -> None:
    router = BackendRouter({'m': [_bc('http://c', 2), _bc('http://a', 0), _bc('http://b', 1)]})
    picks = router.attempts('m')
    assert [p.backend.url for p in picks] == ['http://a', 'http://b', 'http://c']
    assert [p.group_index for p in picks] == [0, 1, 2]
