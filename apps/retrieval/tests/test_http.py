"""Tests HTTP : on couvre /health et /v1/embeddings sans Qdrant.

L'indexation et la recherche dépendent de Qdrant — on les couvrira en
intégration via testcontainers dans une suite séparée.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from retrieval.http import create_app


def test_health() -> None:
    client = TestClient(create_app())
    res = client.get('/health')
    assert res.status_code == 200
    assert res.json() == {'status': 'ok'}


def test_embeddings_returns_vectors_with_expected_dim() -> None:
    client = TestClient(create_app())
    res = client.post('/v1/embeddings', json={'texts': ['hello', 'world']})
    assert res.status_code == 200
    body = res.json()
    assert len(body['vectors']) == 2
    assert all(len(v) == body['dim'] for v in body['vectors'])


def test_embeddings_rejects_empty() -> None:
    client = TestClient(create_app())
    res = client.post('/v1/embeddings', json={'texts': []})
    assert res.status_code == 422


def test_embeddings_are_deterministic() -> None:
    client = TestClient(create_app())
    a = client.post('/v1/embeddings', json={'texts': ['même texte']}).json()
    b = client.post('/v1/embeddings', json={'texts': ['même texte']}).json()
    assert a['vectors'] == b['vectors']
