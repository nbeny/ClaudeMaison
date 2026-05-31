"""Caractérisation tools.registry — base + builtins.

Le registre est la frontière publique du service tools : c'est lui qui
décide quels outils sont exposés via gRPC. Invariants à verrouiller :

  base.ToolRegistry :
    - dup detection : register(même nom 2x) → ValueError. Sans ça, le
      second register écraserait silencieusement le premier, ce qui
      permet à un module mal placé de remplacer 'http_get' par un
      exfiltrateur sans alerte.
    - get(name) → None si absent (PAS KeyError). L'Executor s'appuie
      dessus pour transformer un nom inconnu en ExecutionResult propre.
    - list() retourne l'ordre d'insertion. Le client GraphQL/CLI peut
      itérer dessus pour afficher la liste — un ordre instable casserait
      les snapshots de doc.

  builtins :
    - build_default_registry() expose EXACTEMENT {'echo', 'http_get'}.
      Ajouter un outil ici doit être un acte conscient avec test —
      pas un import side-effect.
    - _echo : message non-string → ValueError. Garde-fou typage runtime
      car les args JSON n'ont pas de schéma fort en Python.
    - _http_get : refuse les URLs non-http(s). Bloque file:// (LFI),
      ftp://, gopher://, etc. Sans ça, le tool devient une SSRF.
    - _http_get : follow_redirects=False. Empêche le contournement
      d'une allowlist future via redirect 302.
    - _http_get : body tronqué à HTTP_MAX_BYTES. Anti-OOM.
    - _http_get : truncated=True quand la coupe a lieu — pour que le
      caller LLM voie qu'il manque du contenu.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tools.registry import ToolDescriptor, ToolRegistry, build_default_registry
from tools.registry.builtins import _echo, _http_get


async def _noop(_: dict[str, Any]) -> dict[str, Any]:
    return {}


def _descriptor(name: str = 'x') -> ToolDescriptor:
    return ToolDescriptor(
        name=name,
        description='',
        arguments_schema={'type': 'object'},
        handler=_noop,
    )


class TestToolRegistryRegister:
    def test_register_stores_tool(self) -> None:
        reg = ToolRegistry()
        reg.register(_descriptor('foo'))
        assert reg.get('foo') is not None

    def test_register_duplicate_name_raises(self) -> None:
        # Garde-fou anti-shadowing. Sans cette ValueError, un second
        # register('http_get', evil_handler) écraserait silencieusement
        # le builtin et exfiltrerait toutes les requêtes.
        reg = ToolRegistry()
        reg.register(_descriptor('foo'))
        with pytest.raises(ValueError, match='already registered: foo'):
            reg.register(_descriptor('foo'))

    def test_register_error_message_includes_name(self) -> None:
        # Le nom dans le message est nécessaire pour diagnostiquer
        # quel outil pose problème quand le registre en contient
        # plusieurs dizaines.
        reg = ToolRegistry()
        reg.register(_descriptor('http_get'))
        with pytest.raises(ValueError, match='http_get'):
            reg.register(_descriptor('http_get'))


class TestToolRegistryGet:
    def test_get_missing_returns_none(self) -> None:
        # Contract avec Executor : nom inconnu → None, pas KeyError.
        # Si on changeait vers KeyError, l'Executor afficherait une
        # stack-trace Python au lieu d'un ExecutionResult error.
        assert ToolRegistry().get('absent') is None

    def test_get_existing_returns_descriptor(self) -> None:
        reg = ToolRegistry()
        d = _descriptor('foo')
        reg.register(d)
        assert reg.get('foo') is d


class TestToolRegistryList:
    def test_list_empty(self) -> None:
        assert ToolRegistry().list() == []

    def test_list_returns_insertion_order(self) -> None:
        # dict Python >=3.7 garantit l'ordre d'insertion. Le client
        # ListTools s'appuie dessus pour un affichage déterministe.
        reg = ToolRegistry()
        a = _descriptor('a')
        b = _descriptor('b')
        c = _descriptor('c')
        reg.register(a)
        reg.register(b)
        reg.register(c)
        assert [t.name for t in reg.list()] == ['a', 'b', 'c']

    def test_list_returns_new_list_not_view(self) -> None:
        # list() doit renvoyer une copie. Sinon, un caller pourrait
        # muter l'état interne du registre.
        reg = ToolRegistry()
        reg.register(_descriptor('foo'))
        snapshot = reg.list()
        snapshot.clear()
        assert len(reg.list()) == 1


class TestBuildDefaultRegistry:
    def test_returns_tool_registry_instance(self) -> None:
        assert isinstance(build_default_registry(), ToolRegistry)

    def test_contains_echo(self) -> None:
        # Le builtin 'echo' est le smoke-test E2E gRPC. Le retirer
        # casserait make smoke-chat sans diagnostic clair.
        assert build_default_registry().get('echo') is not None

    def test_contains_http_get(self) -> None:
        assert build_default_registry().get('http_get') is not None

    def test_exposes_exactly_two_tools(self) -> None:
        # CONTRACT FORT : ajouter un outil = test explicite ici.
        # Sinon on se retrouve à exposer du code expérimental en prod
        # par accident d'import.
        names = {t.name for t in build_default_registry().list()}
        assert names == {'echo', 'http_get'}


class TestEchoHandler:
    @pytest.mark.asyncio
    async def test_returns_message(self) -> None:
        result = await _echo({'message': 'hello'})
        assert result == {'message': 'hello'}

    @pytest.mark.asyncio
    async def test_missing_message_defaults_to_empty(self) -> None:
        # Compromis pragmatique : pas d'argument → string vide.
        # Sinon le smoke test devrait toujours fournir un message.
        result = await _echo({})
        assert result == {'message': ''}

    @pytest.mark.asyncio
    async def test_non_string_message_raises(self) -> None:
        # Garde-fou typage runtime. Le LLM peut envoyer n'importe quoi.
        with pytest.raises(ValueError, match='message must be a string'):
            await _echo({'message': 42})

    @pytest.mark.asyncio
    async def test_list_message_raises(self) -> None:
        with pytest.raises(ValueError, match='message must be a string'):
            await _echo({'message': ['a', 'b']})


class TestHttpGetUrlValidation:
    @pytest.mark.asyncio
    async def test_missing_url_raises(self) -> None:
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({})

    @pytest.mark.asyncio
    async def test_relative_url_raises(self) -> None:
        # Pas de relative — éviterait toute logique de base URL côté
        # caller et créerait une zone de surprise.
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({'url': '/api/foo'})

    @pytest.mark.asyncio
    async def test_file_scheme_raises(self) -> None:
        # CRITIQUE : file:// = Local File Inclusion. Le LLM ne doit
        # JAMAIS pouvoir lire /etc/passwd via http_get.
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({'url': 'file:///etc/passwd'})

    @pytest.mark.asyncio
    async def test_ftp_scheme_raises(self) -> None:
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({'url': 'ftp://example.com/x'})

    @pytest.mark.asyncio
    async def test_gopher_scheme_raises(self) -> None:
        # gopher:// historiquement utilisé pour SSRF (smuggling).
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({'url': 'gopher://example.com/'})

    @pytest.mark.asyncio
    async def test_non_string_url_raises(self) -> None:
        with pytest.raises(ValueError, match='url must be an absolute http'):
            await _http_get({'url': 42})


class TestHttpGetBehavior:
    @pytest.mark.asyncio
    async def test_returns_status_headers_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def _handler(request: httpx.Request) -> httpx.Response:
            captured['url'] = str(request.url)
            return httpx.Response(200, headers={'x-test': 'v'}, content=b'hello world')

        transport = httpx.MockTransport(_handler)

        class _MockClient(httpx.AsyncClient):
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw
                super().__init__(transport=transport)

        monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)
        result = await _http_get({'url': 'http://example.com/foo'})
        assert result['status'] == 200
        assert result['headers']['x-test'] == 'v'
        assert result['body'] == 'hello world'
        assert result['truncated'] is False

    @pytest.mark.asyncio
    async def test_follow_redirects_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # CRITIQUE : si on followait les redirects, une URL whitelistée
        # qui redirige vers une URL interne contournerait la futur
        # allowlist. À tester sans futur même.
        captured: dict[str, Any] = {}

        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        transport = httpx.MockTransport(_handler)

        class _MockClient(httpx.AsyncClient):
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw
                super().__init__(transport=transport)

        monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)
        await _http_get({'url': 'https://example.com/'})
        assert captured['kwargs']['follow_redirects'] is False

    @pytest.mark.asyncio
    async def test_timeout_uses_settings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        captured: dict[str, Any] = {}

        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        transport = httpx.MockTransport(_handler)

        class _MockClient(httpx.AsyncClient):
            def __init__(self, **kw: Any) -> None:
                captured['kwargs'] = kw
                super().__init__(transport=transport)

        monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)
        from tools.config import get_settings

        await _http_get({'url': 'https://example.com/'})
        assert captured['kwargs']['timeout'] == get_settings().TOOL_TIMEOUT_S

    @pytest.mark.asyncio
    async def test_body_truncated_when_over_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Anti-OOM. Le LLM s'attend à voir truncated=True pour ne pas
        # halluciner la complétude du contenu.
        from tools.config import get_settings

        oversized = b'x' * (get_settings().HTTP_MAX_BYTES + 100)

        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=oversized)

        transport = httpx.MockTransport(_handler)

        class _MockClient(httpx.AsyncClient):
            def __init__(self, **kw: Any) -> None:
                super().__init__(transport=transport)

        monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)
        result = await _http_get({'url': 'https://example.com/'})
        assert len(result['body']) == get_settings().HTTP_MAX_BYTES
        assert result['truncated'] is True

    @pytest.mark.asyncio
    async def test_body_not_truncated_when_under_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'small')

        transport = httpx.MockTransport(_handler)

        class _MockClient(httpx.AsyncClient):
            def __init__(self, **kw: Any) -> None:
                super().__init__(transport=transport)

        monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)
        result = await _http_get({'url': 'https://example.com/'})
        assert result['truncated'] is False


class TestBuildDefaultRegistrySchemas:
    """Les arguments_schema sont lus par les LLMs pour faire du tool-use."""

    def test_echo_schema_requires_message(self) -> None:
        # Schéma exposé via ListTools puis envoyé au LLM. Le 'required'
        # est crucial pour que le LLM ne génère pas une call sans args.
        echo = build_default_registry().get('echo')
        assert echo is not None
        assert echo.arguments_schema['required'] == ['message']

    def test_http_get_schema_requires_url(self) -> None:
        http_get = build_default_registry().get('http_get')
        assert http_get is not None
        assert http_get.arguments_schema['required'] == ['url']
