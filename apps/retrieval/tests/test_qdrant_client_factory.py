"""Caractérisation retrieval.qdrant_client_factory.

Une seule instance d'AsyncQdrantClient par process (le client gère son
pool HTTP en interne). ensure_collection est idempotent et utilise
distance COSINE.

Invariants à verrouiller :

  - get_client est lru_cached : N appels → 1 instance. Sans ça, on
    fuirait des pools HTTP à chaque requête.

  - get_client passe URL + api_key depuis Settings. Si on durcissait
    QDRANT_API_KEY sans répercuter ici, on enverrait des requêtes
    anonymes contre une instance protégée et obtiendrait des 401.

  - ensure_collection retourne SANS appeler create si la collection
    existe déjà. Sinon, on aurait une race au boot worker quand
    plusieurs process tentent de la créer en parallèle.

  - ensure_collection appelle create_collection avec :
        size = dim (paramètre)
        distance = COSINE (PAS Dot / Euclidean)
    Le choix COSINE est aligné sur la sortie EmbeddingStub qui vit
    dans [-1, 1]. Changer ici sans changer là-bas = retrieval cassé.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from qdrant_client.http import models as qmodels

from retrieval import qdrant_client_factory as qcf
from retrieval.config import get_settings


@pytest.fixture(autouse=True)
def _clear_caches() -> None:
    get_settings.cache_clear()
    qcf.get_client.cache_clear()
    yield
    get_settings.cache_clear()
    qcf.get_client.cache_clear()


class TestGetClientMemoization:
    def test_returns_same_instance_on_repeat_call(self) -> None:
        # Sans cache, chaque appel reconstruit un pool HTTP qui
        # n'est jamais fermé → fuite de file descriptors.
        with patch.object(qcf, 'AsyncQdrantClient') as Client:
            Client.return_value = MagicMock()
            c1 = qcf.get_client()
            c2 = qcf.get_client()
            assert c1 is c2
            assert Client.call_count == 1

    def test_cache_clear_forces_new_instance(self) -> None:
        with patch.object(qcf, 'AsyncQdrantClient') as Client:
            Client.side_effect = [MagicMock(), MagicMock()]
            c1 = qcf.get_client()
            qcf.get_client.cache_clear()
            c2 = qcf.get_client()
            assert c1 is not c2
            assert Client.call_count == 2


class TestGetClientArgs:
    def test_passes_url_from_settings(self) -> None:
        # Évite de dupliquer la valeur dans le factory.
        with patch.object(qcf, 'AsyncQdrantClient') as Client:
            Client.return_value = MagicMock()
            qcf.get_client()
            _, kwargs = Client.call_args
            assert kwargs['url'] == get_settings().QDRANT_URL

    def test_passes_api_key_from_settings_when_none(self) -> None:
        with patch.object(qcf, 'AsyncQdrantClient') as Client:
            Client.return_value = MagicMock()
            qcf.get_client()
            _, kwargs = Client.call_args
            assert kwargs['api_key'] is None

    def test_passes_api_key_from_settings_when_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Si on oubliait de forwarder api_key, prod cloud échouerait
        # silencieusement avec 401 sur toutes les requêtes.
        monkeypatch.setenv('QDRANT_API_KEY', 'secret-xyz')
        get_settings.cache_clear()
        with patch.object(qcf, 'AsyncQdrantClient') as Client:
            Client.return_value = MagicMock()
            qcf.get_client()
            _, kwargs = Client.call_args
            assert kwargs['api_key'] == 'secret-xyz'


class TestEnsureCollectionIdempotence:
    @pytest.mark.asyncio
    async def test_skips_create_when_collection_exists(self) -> None:
        # Sans ce skip, race au boot quand 2 workers démarrent en
        # parallèle : les deux tentent CREATE, le second prend un 409.
        existing = SimpleNamespace(
            collections=[SimpleNamespace(name=get_settings().QDRANT_COLLECTION)]
        )
        fake = MagicMock()
        fake.get_collections = AsyncMock(return_value=existing)
        fake.create_collection = AsyncMock()
        with patch.object(qcf, 'AsyncQdrantClient', return_value=fake):
            await qcf.ensure_collection(1024)
        fake.create_collection.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_create_when_other_collections_exist(self) -> None:
        # Pas de match par nom — on doit créer celle qui manque.
        existing = SimpleNamespace(
            collections=[SimpleNamespace(name='something_else')]
        )
        fake = MagicMock()
        fake.get_collections = AsyncMock(return_value=existing)
        fake.create_collection = AsyncMock()
        with patch.object(qcf, 'AsyncQdrantClient', return_value=fake):
            await qcf.ensure_collection(1024)
        fake.create_collection.assert_called_once()


class TestEnsureCollectionCreate:
    @pytest.mark.asyncio
    async def test_creates_with_correct_name(self) -> None:
        existing = SimpleNamespace(collections=[])
        fake = MagicMock()
        fake.get_collections = AsyncMock(return_value=existing)
        fake.create_collection = AsyncMock()
        with patch.object(qcf, 'AsyncQdrantClient', return_value=fake):
            await qcf.ensure_collection(512)
        _, kwargs = fake.create_collection.call_args
        assert kwargs['collection_name'] == get_settings().QDRANT_COLLECTION

    @pytest.mark.asyncio
    async def test_creates_with_dim_param(self) -> None:
        existing = SimpleNamespace(collections=[])
        fake = MagicMock()
        fake.get_collections = AsyncMock(return_value=existing)
        fake.create_collection = AsyncMock()
        with patch.object(qcf, 'AsyncQdrantClient', return_value=fake):
            await qcf.ensure_collection(512)
        _, kwargs = fake.create_collection.call_args
        params: Any = kwargs['vectors_config']
        assert params.size == 512

    @pytest.mark.asyncio
    async def test_creates_with_cosine_distance(self) -> None:
        # CRITIQUE : COSINE est aligné avec EmbeddingStub qui vit
        # dans [-1, 1]. Passer en Dot ou Euclidean fausserait tous
        # les scores de similarité sans message d'erreur.
        existing = SimpleNamespace(collections=[])
        fake = MagicMock()
        fake.get_collections = AsyncMock(return_value=existing)
        fake.create_collection = AsyncMock()
        with patch.object(qcf, 'AsyncQdrantClient', return_value=fake):
            await qcf.ensure_collection(1024)
        _, kwargs = fake.create_collection.call_args
        params: Any = kwargs['vectors_config']
        assert params.distance == qmodels.Distance.COSINE
