"""Caractérisation retrieval.embedding — stub déterministe.

EmbeddingStub n'est PAS l'embedder de prod. C'est un fallback
déterministe (hash SHA256) qui sert :
  - aux tests d'intégration de l'indexation/recherche bout en bout,
  - au smoke local sans télécharger 200 Mo de modèles.

Invariants à verrouiller :

  - dim DEFAULT lue depuis Settings.EMBEDDING_DIM (1024 par défaut).
    Si on hardcodait 384 ici par exemple, on enverrait des vecteurs
    incohérents avec la collection Qdrant et tous les upserts
    échoueraient avec un message obscur côté serveur.

  - Composantes ∈ [-1, 1]. Distance COSINE assume des vecteurs
    normalisés-ish. Sortir de cet intervalle ne casse pas en théorie
    mais peut produire des comportements surprenants en pratique.

  - DÉTERMINISME : embed(t) == embed(t) sur deux appels. Sans ça,
    le test 'retrieve le même doc indexé' devient flaky.

  - embed_batch est un loop simple sur embed — pas d'optimisation
    qui changerait la sémantique.
"""

from __future__ import annotations

import pytest

from retrieval.config import get_settings
from retrieval.embedding import EmbeddingStub


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> None:
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestDimDefault:
    def test_dim_defaults_to_settings_embedding_dim(self) -> None:
        # Sans ça, on aurait deux sources de vérité pour la dimension
        # (Settings et un default hardcodé) qui dériveraient.
        assert EmbeddingStub().dim == get_settings().EMBEDDING_DIM

    def test_dim_default_is_1024(self) -> None:
        # Sanity-check : BGE-large-fr = 1024. Si quelqu'un baisse la
        # dim de Settings sans coordination, l'index Qdrant existant
        # devient incompatible.
        assert EmbeddingStub().dim == 1024

    def test_dim_override_via_constructor(self) -> None:
        assert EmbeddingStub(dim=64).dim == 64


class TestEmbedShape:
    def test_embed_returns_list_of_correct_length(self) -> None:
        emb = EmbeddingStub(dim=64).embed('hello')
        assert isinstance(emb, list)
        assert len(emb) == 64

    def test_embed_returns_floats(self) -> None:
        emb = EmbeddingStub(dim=8).embed('x')
        assert all(isinstance(v, float) for v in emb)


class TestEmbedRange:
    def test_components_within_minus1_plus1(self) -> None:
        # Plage [-1, 1] pour rester compatible distance COSINE.
        # Sortir de cette plage = surprise pour le caller qui passe
        # ensuite par Qdrant.
        emb = EmbeddingStub(dim=256).embed('lorem ipsum dolor')
        assert all(-1.0 <= v <= 1.0 for v in emb)

    def test_empty_string_components_within_range(self) -> None:
        emb = EmbeddingStub(dim=128).embed('')
        assert all(-1.0 <= v <= 1.0 for v in emb)

    def test_unicode_components_within_range(self) -> None:
        # SHA256 sur bytes UTF-8 — vérifier que les accents ne sortent
        # pas de la plage.
        emb = EmbeddingStub(dim=128).embed('été où ça')
        assert all(-1.0 <= v <= 1.0 for v in emb)


class TestDeterminism:
    def test_same_input_same_output(self) -> None:
        # CRITIQUE : sans déterminisme, le test 'retrieve doc indexé'
        # devient flaky car le vecteur de query diffère du vecteur
        # stocké.
        e = EmbeddingStub(dim=32)
        assert e.embed('hello') == e.embed('hello')

    def test_different_input_different_output(self) -> None:
        # Pas une garantie cryptographique, mais sur 32 composantes
        # SHA256 c'est essentiellement certain.
        e = EmbeddingStub(dim=32)
        assert e.embed('a') != e.embed('b')

    def test_determinism_across_instances(self) -> None:
        # embed est stateless, peu importe l'instance.
        assert EmbeddingStub(dim=16).embed('x') == EmbeddingStub(dim=16).embed('x')


class TestEmbedBatch:
    def test_batch_returns_one_vector_per_input(self) -> None:
        out = EmbeddingStub(dim=16).embed_batch(['a', 'b', 'c'])
        assert len(out) == 3

    def test_batch_preserves_order(self) -> None:
        # Si le batch ré-ordonnait, le caller perdrait la correspondance
        # entre texte d'entrée et vecteur en sortie.
        e = EmbeddingStub(dim=16)
        single = [e.embed('a'), e.embed('b'), e.embed('c')]
        assert e.embed_batch(['a', 'b', 'c']) == single

    def test_batch_empty_returns_empty(self) -> None:
        assert EmbeddingStub(dim=16).embed_batch([]) == []

    def test_batch_consistent_with_embed(self) -> None:
        # embed_batch DOIT être équivalent à [embed(t) for t in texts].
        # Si on introduit une optim qui change la sémantique (genre
        # quantization), il faut un nouveau type — pas un changement
        # silencieux.
        e = EmbeddingStub(dim=32)
        assert e.embed_batch(['x', 'y']) == [e.embed('x'), e.embed('y')]
