"""Caractérisation des endpoints /v1/index et /v1/search.

Le test_http.py existant couvre /health et /v1/embeddings sans Qdrant.
Il documente "indexation et recherche couvertes en intégration via
testcontainers". Or l'intégration teste le bout-en-bout, pas les
invariants subtils côté wire entre HTTP et qdrant-client. Ce fichier
les verrouille avec des AsyncMock — pas de container nécessaire.

Invariants verrouillés :

  /v1/index :
    - id absent → UUID4 généré (36 chars, 4 tirets)
    - id fourni → utilisé tel quel
    - ensure_collection appelé AVEC embedder.dim AVANT upsert. Si on
      crée la collection sans connaître la dim, Qdrant rejette l'upsert
      (dim mismatch) sans message explicite.
    - upsert ciblé sur settings.QDRANT_COLLECTION ('documents')
    - payload Qdrant = {'text': p.text, **p.metadata} : `text` est
      MERGÉ avec metadata via spread. Si metadata contient 'text',
      il ÉCRASE le vrai texte. Cas adversarial verrouillé pour
      qu'une éventuelle correction soit explicite.
    - vecteurs générés depuis les TEXTS (pas les ids)

  /v1/search :
    - top_k → limit (renommage critique)
    - with_payload=True obligatoire (sans ça : text vide partout)
    - exception Qdrant → 502 (Bad Gateway), pas 500. Sémantiquement
      upstream-error, filtré différemment par les SRE.
    - id renvoyé en str (Qdrant peut renvoyer int/UUID natif)
    - text extrait de payload, metadata = tout sauf 'text'
    - payload None ou sans 'text' → text='', metadata={} (robuste)
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from retrieval.embedding import EmbeddingStub
from retrieval.http import create_app


@pytest.fixture
def embedder() -> EmbeddingStub:
    return EmbeddingStub(dim=8)


@pytest.fixture
def app(embedder: EmbeddingStub) -> TestClient:
    return TestClient(create_app(embedder=embedder))


def _mock_response(points: list[Any]) -> Any:
    return SimpleNamespace(points=points)


def _mock_point(
    id: Any = 'p1',
    score: float = 0.5,
    payload: dict[str, Any] | None = None,
) -> Any:
    return SimpleNamespace(id=id, score=score, payload=payload)


# ---------------------------------------------------------------------------
# /v1/index
# ---------------------------------------------------------------------------


class TestIndexEndpointIdGeneration:
    def test_generates_uuid_when_id_absent(self, app: TestClient) -> None:
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=AsyncMock())
            res = app.post('/v1/index', json={'points': [{'text': 'hello'}]})
        ids = res.json()['ids']
        assert len(ids) == 1
        # UUID4 stringifié = 36 chars (8-4-4-4-12).
        assert len(ids[0]) == 36
        assert ids[0].count('-') == 4

    def test_uses_explicit_id_when_provided(self, app: TestClient) -> None:
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=AsyncMock())
            res = app.post(
                '/v1/index', json={'points': [{'id': 'doc-42', 'text': 'hi'}]}
            )
        assert res.json()['ids'] == ['doc-42']

    def test_mixed_ids_preserved_in_order(self, app: TestClient) -> None:
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=AsyncMock())
            res = app.post(
                '/v1/index',
                json={
                    'points': [
                        {'id': 'a', 'text': '1'},
                        {'text': '2'},
                        {'id': 'c', 'text': '3'},
                    ]
                },
            )
        ids = res.json()['ids']
        assert ids[0] == 'a'
        assert ids[2] == 'c'
        assert len(ids[1]) == 36


class TestIndexEndpointQdrantCall:
    def test_ensure_collection_called_with_embedder_dim(
        self, app: TestClient, embedder: EmbeddingStub
    ) -> None:
        # Sans cet appel AVEC la bonne dim, la collection serait créée
        # avec une mauvaise taille → upsert échoue plus tard.
        mock_ensure = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=mock_ensure),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=AsyncMock())
            app.post('/v1/index', json={'points': [{'text': 'hi'}]})
        mock_ensure.assert_awaited_once_with(embedder.dim)

    def test_upsert_targets_settings_collection(self, app: TestClient) -> None:
        # Le nom 'documents' est config — changer en config sans répercuter
        # ici romp l'index existant.
        upsert = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=upsert)
            app.post('/v1/index', json={'points': [{'text': 'hi'}]})
        _, kwargs = upsert.call_args
        assert kwargs['collection_name'] == 'documents'

    def test_upsert_point_payload_includes_text(self, app: TestClient) -> None:
        upsert = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=upsert)
            app.post(
                '/v1/index', json={'points': [{'text': 'le texte du doc'}]}
            )
        _, kwargs = upsert.call_args
        assert kwargs['points'][0].payload['text'] == 'le texte du doc'

    def test_upsert_payload_flattens_metadata(self, app: TestClient) -> None:
        # metadata est SPREAD : `{'text': ..., **metadata}`. Pas de
        # wrapping. Pour `query_payload->lang` côté Qdrant filter.
        upsert = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=upsert)
            app.post(
                '/v1/index',
                json={
                    'points': [
                        {
                            'text': 'hi',
                            'metadata': {'lang': 'fr', 'source': 'manual'},
                        }
                    ]
                },
            )
        _, kwargs = upsert.call_args
        payload = kwargs['points'][0].payload
        assert payload['lang'] == 'fr'
        assert payload['source'] == 'manual'

    def test_metadata_text_key_overwrites_doc_text(self, app: TestClient) -> None:
        # Cas ADVERSARIAL documenté par le code source :
        # `{'text': p.text, **p.metadata}` → si metadata contient 'text',
        # il écrase. Comportement actuel verrouillé ; à corriger en
        # explicite (rejet ou rename) plus tard.
        upsert = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=upsert)
            app.post(
                '/v1/index',
                json={
                    'points': [
                        {
                            'text': 'document réel',
                            'metadata': {'text': 'écrasé par metadata'},
                        }
                    ]
                },
            )
        _, kwargs = upsert.call_args
        assert kwargs['points'][0].payload['text'] == 'écrasé par metadata'

    def test_vectors_come_from_text_not_id(
        self, app: TestClient, embedder: EmbeddingStub
    ) -> None:
        # Sanity : embed_batch reçoit les TEXTS. Embedder déterministe →
        # vecteur de 'foo' identique à embed('foo') direct.
        upsert = AsyncMock()
        with (
            patch('retrieval.http.ensure_collection', new=AsyncMock()),
            patch('retrieval.http.get_client') as mock_get,
        ):
            mock_get.return_value = SimpleNamespace(upsert=upsert)
            app.post(
                '/v1/index',
                json={'points': [{'id': 'IGNORE_ME', 'text': 'foo'}]},
            )
        _, kwargs = upsert.call_args
        assert kwargs['points'][0].vector == embedder.embed('foo')


# ---------------------------------------------------------------------------
# /v1/search
# ---------------------------------------------------------------------------


class TestSearchEndpointQdrantArgs:
    def test_top_k_maps_to_limit(self, app: TestClient) -> None:
        # Renommage critique. Si quelqu'un utilisait `limit=req.limit`
        # (champ inexistant), ça partirait en KeyError silencieux.
        query_points = AsyncMock(return_value=_mock_response([]))
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            app.post('/v1/search', json={'query': 'q', 'top_k': 5})
        _, kwargs = query_points.call_args
        assert kwargs['limit'] == 5

    def test_with_payload_is_true(self, app: TestClient) -> None:
        # CRITIQUE : sans with_payload=True, Qdrant renvoie points sans
        # payload → hits.text = '' partout. Régression silencieuse
        # qui ne casse aucun test E2E si on ne vérifie pas le contenu.
        query_points = AsyncMock(return_value=_mock_response([]))
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            app.post('/v1/search', json={'query': 'q'})
        _, kwargs = query_points.call_args
        assert kwargs['with_payload'] is True

    def test_collection_name_from_settings(self, app: TestClient) -> None:
        query_points = AsyncMock(return_value=_mock_response([]))
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            app.post('/v1/search', json={'query': 'q'})
        _, kwargs = query_points.call_args
        assert kwargs['collection_name'] == 'documents'

    def test_top_k_default_is_8(self, app: TestClient) -> None:
        # Si on changeait le défaut Pydantic, les caller existants
        # verraient un comportement différent sans avertissement.
        query_points = AsyncMock(return_value=_mock_response([]))
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            app.post('/v1/search', json={'query': 'q'})
        _, kwargs = query_points.call_args
        assert kwargs['limit'] == 8


class TestSearchEndpointResponseShape:
    def test_id_is_stringified(self, app: TestClient) -> None:
        # Qdrant peut renvoyer int en id natif. Contrat HTTP = str.
        # Si on cassait ce cast, le frontend reçoit un type incohérent
        # (number certains jours, string les autres).
        query_points = AsyncMock(
            return_value=_mock_response(
                [_mock_point(id=12345, score=0.9, payload={'text': 'x'})]
            )
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert res.json()['hits'][0]['id'] == '12345'

    def test_text_extracted_from_payload(self, app: TestClient) -> None:
        query_points = AsyncMock(
            return_value=_mock_response(
                [_mock_point(payload={'text': 'le contenu', 'lang': 'fr'})]
            )
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert res.json()['hits'][0]['text'] == 'le contenu'

    def test_metadata_excludes_text_key(self, app: TestClient) -> None:
        # Contrat inverse de l'upsert : text est séparé du reste.
        # Si on cassait ce split, metadata aurait le doc en double
        # (gonflement payload SSE → coût ressources).
        query_points = AsyncMock(
            return_value=_mock_response(
                [_mock_point(payload={'text': 'doc', 'lang': 'fr', 'src': 'm'})]
            )
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        meta = res.json()['hits'][0]['metadata']
        assert 'text' not in meta
        assert meta == {'lang': 'fr', 'src': 'm'}

    def test_missing_text_in_payload_defaults_to_empty(
        self, app: TestClient
    ) -> None:
        # Robustesse : un point indexé hors de notre route /v1/index
        # (outil externe, migration) ne doit pas faire planter la
        # response.
        query_points = AsyncMock(
            return_value=_mock_response([_mock_point(payload={'lang': 'fr'})])
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert res.json()['hits'][0]['text'] == ''

    def test_none_payload_does_not_raise(self, app: TestClient) -> None:
        # Edge case : Qdrant peut renvoyer payload=None.
        query_points = AsyncMock(
            return_value=_mock_response([_mock_point(payload=None)])
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert res.status_code == 200
        hit = res.json()['hits'][0]
        assert hit['text'] == ''
        assert hit['metadata'] == {}

    def test_score_coerced_to_float(self, app: TestClient) -> None:
        # Sanity : si Qdrant renvoyait un Decimal ou autre, on doit
        # toujours sortir un float JSON (sinon serialization échoue).
        query_points = AsyncMock(
            return_value=_mock_response(
                [_mock_point(score=0.85, payload={'text': 'x'})]
            )
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert isinstance(res.json()['hits'][0]['score'], float)


class TestSearchEndpointErrorMapping:
    def test_qdrant_exception_becomes_502(self, app: TestClient) -> None:
        # 502 (Bad Gateway), PAS 500. Sémantiquement c'est une erreur
        # upstream — les alertes SRE filtrent là-dessus.
        query_points = AsyncMock(
            side_effect=RuntimeError('qdrant connection refused')
        )
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert res.status_code == 502

    def test_qdrant_exception_detail_contains_prefix(self, app: TestClient) -> None:
        # Préfixe 'qdrant:' permet aux logs côté frontend de classer
        # l'erreur sans parser le message complet.
        query_points = AsyncMock(side_effect=RuntimeError('timeout after 5s'))
        with patch('retrieval.http.get_client') as mock_get:
            mock_get.return_value = SimpleNamespace(query_points=query_points)
            res = app.post('/v1/search', json={'query': 'q'})
        assert 'qdrant' in res.json()['detail']


class TestSearchEndpointValidation:
    def test_empty_query_rejected_422(self, app: TestClient) -> None:
        res = app.post('/v1/search', json={'query': ''})
        assert res.status_code == 422

    def test_top_k_zero_rejected_422(self, app: TestClient) -> None:
        res = app.post('/v1/search', json={'query': 'q', 'top_k': 0})
        assert res.status_code == 422

    def test_top_k_above_max_rejected_422(self, app: TestClient) -> None:
        # Limite à 64. Au-delà, on tape le timeout Qdrant et on dégrade
        # la latence pour tous.
        res = app.post('/v1/search', json={'query': 'q', 'top_k': 65})
        assert res.status_code == 422
