"""Embedding stub.

Au Jour-1 on n'embarque pas fastembed/sentence-transformers (200+ Mo de
modèles ONNX). On expose une interface qui prend du texte, renvoie un vecteur
de dimension EMBEDDING_DIM. Implémentation actuelle : vecteur déterministe
basé sur hash — c'est de la merde sémantique mais ça permet de tester
l'indexation/recherche bout en bout. À remplacer par fastembed BGE-large-fr
(cf. ADR-0007) sur une branche dédiée.
"""

from __future__ import annotations

import hashlib

from retrieval.config import get_settings


class EmbeddingStub:
    """Embedder déterministe pour tests d'intégration."""

    def __init__(self, dim: int | None = None) -> None:
        self.dim = dim or get_settings().EMBEDDING_DIM

    def embed(self, text: str) -> list[float]:
        # SHA256 -> 32 octets -> on étire en {dim} flottants ∈ [-1, 1].
        digest = hashlib.sha256(text.encode('utf-8')).digest()
        # Cycle sur les octets ; les composantes ne sont pas indépendantes, mais
        # c'est sans importance tant que c'est déterministe.
        return [(digest[i % len(digest)] / 127.5) - 1.0 for i in range(self.dim)]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(t) for t in texts]
