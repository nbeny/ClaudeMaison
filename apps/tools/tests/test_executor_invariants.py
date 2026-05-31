"""Caractérisation invariants subtils de tools.executor.Executor.

Le test_executor.py existant couvre les happy paths (echo, unknown tool,
JSON invalide, exception, timeout). Ce fichier verrouille des invariants
plus fins, principalement côté sérialisation du résultat et ordre de
gestion des erreurs.

  - **Unicode préservé dans result_json** : `ensure_ascii=False` permet
    aux tools qui renvoient du français de garder leurs accents bruts.
    Sinon le LLM lit du `\\u00e9` au lieu de `é` dans le résultat, ce
    qui gonfle les tokens et dégrade le raisonnement (parallèle direct
    avec test_server.py qui verrouille le même invariant côté schemas).

  - **default=str** dans json.dumps : datetime, UUID, Decimal, etc.
    sont coercés en str au lieu de raise TypeError. Sinon un tool
    qui renvoie un datetime ferait planter SILENCIEUSEMENT l'executor
    (capturé par except Exception en aval, masquant le vrai problème
    de design).

  - **arguments_json vide → {}** : la chaîne vide est traitée comme
    pas d'arguments, pas comme JSON invalide. Permet aux tool calls
    LLM sans paramètres (ex: `get_current_time`) d'être appelés
    sans envoyer `{}` explicite.

  - **JSON valide mais non-dict rejeté** : `42`, `"foo"`, `null`, `true`
    sont du JSON valide mais ne correspondent pas au contrat tool-args
    (qui exige toujours un objet). Le check `isinstance(args, dict)`
    les rejette explicitement. Si on retirait ce check, l'handler
    recevrait `42` au lieu de `{}` et planterait avec AttributeError.

  - **TimeoutError catché AVANT Exception** : `asyncio.wait_for` lève
    `TimeoutError` (qui est `BaseException` en 3.11+ mais hérite de
    `Exception` aussi). Si on inversait l'ordre des except, on aurait
    le message générique `TimeoutError: ` au lieu du message clair
    `tool timed out after Xs`. Critique pour le debug d'un LLM qui
    abuse des tools lents.

  - **duration_ms toujours positif** : même sur erreur (unknown tool,
    JSON invalide), on mesure le temps écoulé. Permet aux dashboards
    OTel de compter ces cas dans la latence p99.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from tools.executor import Executor
from tools.registry import ToolRegistry
from tools.registry.base import ToolDescriptor


def _registry_with(handler: Any, name: str = 'x') -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(
        ToolDescriptor(
            name=name,
            description='',
            arguments_schema={'type': 'object'},
            handler=handler,
        )
    )
    return reg


class TestResultJsonUnicode:
    """ensure_ascii=False — accents bruts dans result_json."""

    async def test_french_accents_preserved_in_result_json(self) -> None:
        # Critique pour la qualité du tool-use : le LLM lit le result_json.
        # Si les accents sont échappés en \u00e9, ça gonfle les tokens
        # et le modèle voit du bruit au lieu du français.
        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {'message': 'éphémère contexte été'}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert result.status == 'ok'
        # Les accents doivent apparaître bruts, PAS échappés.
        assert 'éphémère' in result.result_json
        assert '\\u00e9' not in result.result_json

    async def test_emoji_not_escaped(self) -> None:
        # Même invariant pour les caractères non-ASCII en général.
        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {'reaction': '🚀'}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert '🚀' in result.result_json


class TestResultJsonDefaultStr:
    """default=str — coerce datetime/UUID au lieu de raise."""

    async def test_datetime_coerced_to_string(self) -> None:
        # Sans default=str, json.dumps lèverait TypeError, lequel serait
        # capturé par le except Exception EN AVAL — masquant le vrai
        # problème (tool mal défini retournant un type non-JSON).
        # Ici on verrouille le comportement actuel : coerce silencieux.
        dt = datetime(2026, 1, 15, 10, 30, tzinfo=UTC)

        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {'when': dt}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert result.status == 'ok'
        parsed = json.loads(result.result_json)
        # Le str() d'un datetime aware est lisible et reproductible.
        assert parsed['when'] == str(dt)

    async def test_uuid_coerced_to_string(self) -> None:
        u = UUID('12345678-1234-5678-1234-567812345678')

        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {'id': u}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert result.status == 'ok'
        parsed = json.loads(result.result_json)
        assert parsed['id'] == str(u)


class TestArgumentsJsonEmpty:
    """arguments_json vide ('') → {} (pas une erreur)."""

    async def test_empty_string_arguments_json_becomes_empty_dict(self) -> None:
        # Un LLM qui appelle un tool sans args envoie souvent '' plutôt
        # que '{}'. On doit traiter ça comme {} sans erreur.
        received: list[dict[str, Any]] = []

        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            received.append(args)
            return {'ok': True}

        result = await Executor(_registry_with(handler)).execute('x', '')
        assert result.status == 'ok'
        assert received == [{}]


class TestArgumentsJsonNonDict:
    """JSON valide mais non-objet : rejeté."""

    async def test_json_number_rejected(self) -> None:
        result = await Executor(_registry_with(lambda _: {})).execute('x', '42')
        assert result.status == 'error'
        assert 'must decode to an object' in result.error_message

    async def test_json_string_rejected(self) -> None:
        result = await Executor(_registry_with(lambda _: {})).execute('x', '"foo"')
        assert result.status == 'error'
        assert 'must decode to an object' in result.error_message

    async def test_json_null_rejected(self) -> None:
        # 'null' est JSON valide mais ne correspond pas au contrat.
        result = await Executor(_registry_with(lambda _: {})).execute('x', 'null')
        assert result.status == 'error'
        assert 'must decode to an object' in result.error_message

    async def test_json_bool_rejected(self) -> None:
        result = await Executor(_registry_with(lambda _: {})).execute('x', 'true')
        assert result.status == 'error'
        assert 'must decode to an object' in result.error_message


class TestTimeoutErrorPrecedence:
    """TimeoutError catch avant Exception : message clair vs générique."""

    async def test_timeout_error_message_is_specific(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Si l'ordre except était inversé, on aurait 'TimeoutError: '
        # (générique) au lieu de 'tool timed out after Xs' (spécifique).
        import asyncio

        from tools import config

        async def slow(_: dict[str, Any]) -> dict[str, Any]:
            await asyncio.sleep(1.0)
            return {}

        monkeypatch.setenv('TOOL_TIMEOUT_S', '0.05')
        config.get_settings.cache_clear()
        try:
            result = await Executor(_registry_with(slow)).execute('x', '{}')
        finally:
            config.get_settings.cache_clear()
            monkeypatch.delenv('TOOL_TIMEOUT_S', raising=False)

        assert result.status == 'error'
        # Message SPÉCIFIQUE timeout, pas générique.
        assert 'timed out' in result.error_message
        # Ne doit PAS leak le nom de classe (qui serait là si except Exception
        # avait catché : 'TimeoutError: ').
        assert not result.error_message.startswith('TimeoutError:')


class TestDurationMs:
    """duration_ms est positif et présent même sur chemin d'erreur."""

    async def test_duration_positive_on_success(self) -> None:
        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert result.duration_ms > 0.0

    async def test_duration_positive_on_unknown_tool(self) -> None:
        # Même sur erreur précoce (avant tout handler), on mesure.
        # Critique pour le dashboard OTel : sinon ces appels passent
        # à 0ms et faussent les agrégats p99.
        result = await Executor(ToolRegistry()).execute('nope', '{}')
        assert result.status == 'error'
        assert result.duration_ms > 0.0

    async def test_duration_positive_on_invalid_json(self) -> None:
        result = await Executor(_registry_with(lambda _: {})).execute(
            'x', 'not-json'
        )
        assert result.status == 'error'
        assert result.duration_ms > 0.0

    async def test_duration_positive_on_handler_exception(self) -> None:
        async def boom(_: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError('boom')

        result = await Executor(_registry_with(boom)).execute('x', '{}')
        assert result.status == 'error'
        assert result.duration_ms > 0.0


class TestErrorResultShape:
    """Sur erreur : status='error', result_json='', error_message non-vide."""

    async def test_error_result_json_is_empty_string(self) -> None:
        # Le caller (gRPC servicer) check result_json non-vide pour
        # décider de l'envoyer. Sur erreur on doit avoir '' (pas '{}'
        # ni 'null'), sinon le caller croit qu'il y a un résultat.
        result = await Executor(ToolRegistry()).execute('nope', '{}')
        assert result.result_json == ''

    async def test_error_message_non_empty_on_error(self) -> None:
        result = await Executor(ToolRegistry()).execute('nope', '{}')
        assert result.error_message != ''

    async def test_success_error_message_is_empty(self) -> None:
        # Symétrique : sur succès, error_message='' (pas None, pas ' ').
        async def handler(_: dict[str, Any]) -> dict[str, Any]:
            return {'ok': True}

        result = await Executor(_registry_with(handler)).execute('x', '{}')
        assert result.error_message == ''
