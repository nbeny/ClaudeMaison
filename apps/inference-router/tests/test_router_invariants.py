"""Caractérisation invariants subtils de BackendRouter.

test_router.py couvre 6 happy paths (one pick per group, round-robin
within group/across calls, unknown model, sorted models, 3 priority
groups). Ce fichier verrouille les invariants plus fins.

  - **group_index = POSITION dans l'ordre des priorités, pas priorité brute** :
    si on a priorities [10, 20, 30], les group_index sont 0, 1, 2 — JAMAIS
    10, 20, 30. Le caller HTTP utilise group_index pour des métriques
    "tentative N" — un changement vers la valeur brute casserait les
    dashboards et permettrait des collisions entre modèles.

  - **Insertion-order préservé dans un même groupe de priorité** :
    `sorted(backends, key=priority)` est STABLE en Python — si deux
    backends ont la même priorité, leur ordre relatif d'origine est
    conservé. Si on inversait la stabilité (re-sort par url), le
    round-robin cycliquerait dans un ordre non-déterministe.

  - **Per-model isolation du curseur round-robin** : avancer le curseur
    sur model A ne doit PAS affecter le curseur de model B. Sinon
    appeler `attempts('m1')` "consume" un slot pour `attempts('m2')`.

  - **Per-group isolation à l'intérieur d'un modèle** : les groupes de
    priorité différents ont des curseurs indépendants. Cycle group0
    indépendant de cycle group1.

  - **Empty backends list pour un modèle** : si MODEL_BACKENDS contient
    un modèle avec 0 backends (cas que parse_model_backends rejette
    mais qu'on peut construire programmatiquement), `attempts()`
    retourne [] silencieusement. Le caller HTTP doit décider quoi
    faire — pas notre rôle de raise ici.

  - **BackendPick est frozen et hashable** : peut être utilisé comme
    clé dans un set/dict pour dédup côté metrics. `frozen=True` +
    `slots=True` garantit ça.

  - **attempts() longueur == nombre de priorités distinctes** : invariant
    structurel — un caller HTTP qui itère les picks SAIT combien de
    tentatives max il fera avant d'avoir tout essayé.

  - **Round-robin AVANCE même quand attempts() est appelé plusieurs
    fois** : l'état du cycle est partagé entre appels, pas reset à
    chaque attempts().
"""

from __future__ import annotations

import pytest

from inference_router.config import BackendConfig
from inference_router.router import BackendPick, BackendRouter


def _bc(url: str, prio: int = 0, provider: str = 'llama-cpp') -> BackendConfig:
    return BackendConfig(url=url, provider=provider, priority=prio)


class TestGroupIndexSemantics:
    """group_index est la position dans l'ordre des priorités, pas la valeur."""

    def test_group_index_starts_at_zero_for_lowest_priority(self) -> None:
        # Priorités exotiques 10/20 : on doit voir 0/1, pas 10/20.
        router = BackendRouter({'m': [_bc('http://a', 10), _bc('http://b', 20)]})
        picks = router.attempts('m')
        assert [p.group_index for p in picks] == [0, 1]

    def test_group_index_ignores_priority_gaps(self) -> None:
        # Priorités 5 et 99 → group_index 0 et 1 (pas 5/99, pas 0/94).
        router = BackendRouter({'m': [_bc('http://a', 5), _bc('http://b', 99)]})
        picks = router.attempts('m')
        assert [p.group_index for p in picks] == [0, 1]

    def test_group_index_with_negative_priority(self) -> None:
        # Cas tordu : priorités négatives. group_index reste position.
        router = BackendRouter({'m': [_bc('http://a', -5), _bc('http://b', 0)]})
        picks = router.attempts('m')
        assert [p.group_index for p in picks] == [0, 1]
        assert picks[0].backend.url == 'http://a'  # priorité -5 first

    def test_same_priority_means_single_group(self) -> None:
        # 3 backends même priorité → 1 seul groupe → 1 seul pick.
        router = BackendRouter({
            'm': [_bc('http://a'), _bc('http://b'), _bc('http://c')]
        })
        assert len(router.attempts('m')) == 1


class TestInsertionOrderStability:
    """Tri stable : ordre d'insertion préservé pour priorités égales."""

    def test_round_robin_follows_insertion_order(self) -> None:
        # Construit avec a, b, c dans cet ordre. Cycle dans cet ordre,
        # pas alphabétique ni alphabétique inverse ni par hash.
        router = BackendRouter({
            'm': [_bc('http://c'), _bc('http://a'), _bc('http://b')]
        })
        picks = [router.attempts('m')[0].backend.url for _ in range(6)]
        assert picks == [
            'http://c',
            'http://a',
            'http://b',
            'http://c',
            'http://a',
            'http://b',
        ]


class TestPerModelIsolation:
    """Avancer le round-robin de m1 n'affecte pas m2."""

    def test_advancing_one_model_does_not_advance_another(self) -> None:
        router = BackendRouter({
            'm1': [_bc('http://a1'), _bc('http://b1')],
            'm2': [_bc('http://a2'), _bc('http://b2')],
        })
        # Avance m1 4 fois.
        for _ in range(4):
            router.attempts('m1')
        # m2 doit toujours partir de a2.
        assert router.attempts('m2')[0].backend.url == 'http://a2'
        assert router.attempts('m2')[0].backend.url == 'http://b2'


class TestPerGroupIsolation:
    """À l'intérieur d'un modèle, les groupes ont des curseurs indépendants."""

    def test_high_priority_group_does_not_advance_low_priority(self) -> None:
        # group0 = [a, b], group1 = [c, d]
        router = BackendRouter({
            'm': [
                _bc('http://a', 0),
                _bc('http://b', 0),
                _bc('http://c', 1),
                _bc('http://d', 1),
            ]
        })
        # 1er attempts : (a, c)
        p1 = router.attempts('m')
        # 2e attempts : (b, d) — chaque groupe avance indépendamment
        p2 = router.attempts('m')
        # 3e attempts : (a, c) à nouveau
        p3 = router.attempts('m')
        assert [p.backend.url for p in p1] == ['http://a', 'http://c']
        assert [p.backend.url for p in p2] == ['http://b', 'http://d']
        assert [p.backend.url for p in p3] == ['http://a', 'http://c']

    def test_singleton_group_stays_on_same_backend(self) -> None:
        # Cas réaliste : primary unique + fallback unique. Aucun round-robin
        # observable, mais l'invariant est "next() sur cycle([x]) → x".
        router = BackendRouter({
            'm': [_bc('http://primary', 0), _bc('http://fallback', 1)]
        })
        for _ in range(5):
            picks = router.attempts('m')
            assert [p.backend.url for p in picks] == ['http://primary', 'http://fallback']


class TestEmptyBackendsForModel:
    """Modèle déclaré avec 0 backends : attempts() = [] silencieux."""

    def test_empty_backend_list_yields_empty_picks(self) -> None:
        # parse_model_backends() rejette ce cas, mais on peut le construire
        # programmatiquement. Le router doit ne pas crasher à l'init ni
        # au call : on retourne [] et le caller HTTP décide.
        router = BackendRouter({'m': []})
        # Le modèle est listé.
        assert 'm' in router.models()
        # Mais attempts() retourne [].
        assert router.attempts('m') == []


class TestBackendPickShape:
    """BackendPick frozen+slots : hashable, équatable, immuable."""

    def test_backend_pick_is_hashable(self) -> None:
        # Critique pour les metrics : un caller peut compter par pick
        # via Counter[BackendPick].
        bc = _bc('http://a', 0)
        p = BackendPick(backend=bc, group_index=0)
        # Pas de TypeError au hash : frozen dataclass.
        _ = {p}

    def test_backend_pick_equality_value_based(self) -> None:
        # Deux picks avec mêmes valeurs sont égaux (dataclass eq).
        bc = _bc('http://a', 0)
        p1 = BackendPick(backend=bc, group_index=0)
        p2 = BackendPick(backend=bc, group_index=0)
        assert p1 == p2

    def test_backend_pick_inequality_on_group_index(self) -> None:
        bc = _bc('http://a', 0)
        p1 = BackendPick(backend=bc, group_index=0)
        p2 = BackendPick(backend=bc, group_index=1)
        assert p1 != p2

    def test_backend_pick_immutable(self) -> None:
        bc = _bc('http://a', 0)
        p = BackendPick(backend=bc, group_index=0)
        # frozen → FrozenInstanceError on assign.
        with pytest.raises(Exception):
            p.group_index = 99  # type: ignore[misc]


class TestAttemptsLength:
    """attempts() len == nombre de priorités distinctes."""

    def test_single_priority_yields_single_pick(self) -> None:
        router = BackendRouter({
            'm': [_bc('http://a'), _bc('http://b'), _bc('http://c')]
        })
        assert len(router.attempts('m')) == 1

    def test_two_priorities_yield_two_picks(self) -> None:
        router = BackendRouter({
            'm': [_bc('http://a', 0), _bc('http://b', 1)]
        })
        assert len(router.attempts('m')) == 2

    def test_duplicate_priority_does_not_create_extra_group(self) -> None:
        # Priorités [0, 0, 1, 1, 1, 2] → 3 groupes.
        router = BackendRouter({
            'm': [
                _bc('http://a', 0), _bc('http://b', 0),
                _bc('http://c', 1), _bc('http://d', 1), _bc('http://e', 1),
                _bc('http://f', 2),
            ]
        })
        assert len(router.attempts('m')) == 3


class TestRoundRobinPersistsAcrossCalls:
    """L'état round-robin est PARTAGÉ entre appels, pas réinitialisé."""

    def test_second_call_continues_from_first(self) -> None:
        router = BackendRouter({
            'm': [_bc('http://a'), _bc('http://b'), _bc('http://c')]
        })
        first = router.attempts('m')[0].backend.url
        second = router.attempts('m')[0].backend.url
        # Sur 3 backends round-robin, deux appels consécutifs DOIVENT
        # taper deux backends différents.
        assert first != second
