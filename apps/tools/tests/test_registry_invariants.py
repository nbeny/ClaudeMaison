"""Caractérisation tools.registry.builtins — invariants subtils de _http_get.

test_registry.py couvre la validation d'URL (file://, ftp://, etc.), le
flag follow_redirects, le timeout et 2 cas de truncation (above/below).
Ce fichier verrouille les invariants restants, plus subtils :

  - **STATUS PASSTHROUGH** : un 404 / 500 / 301 upstream NE doit PAS
    raise. _http_get retourne le status verbatim. Le caller LLM s'en
    sert pour décider quoi faire ("la page n'existe pas → arrêter").
    Si on raise sur non-2xx, le tool-use chain explose au premier 404
    et le LLM ne peut pas réagir.

  - **UTF-8 INVALIDE → REPLACEMENT, PAS RAISE** : `errors='replace'`
    sur le decode. Beaucoup de sites cibles servent du contenu binaire,
    du latin-1 mal annoncé, ou du HTML avec des octets invalides. Si on
    raise, le LLM perd un outil critique d'investigation. Le caractère
    de remplacement \\ufffd indique l'erreur sans crasher.

  - **BOUNDARY DE TRUNCATION** : la coupe est `[:HTTP_MAX_BYTES]` et le
    flag est `len(content) > HTTP_MAX_BYTES` (strict). Donc exactly MAX
    bytes → body complet, truncated=False. Si on changeait en `>=`, on
    flagguerait à tort un body pile poil au plafond, et le LLM verrait
    truncated=True alors qu'il a tout reçu → halluciné le manque.

  - **BODY VIDE** : 200 + body=b'' → body='', truncated=False. Pas de
    division par zéro, pas de None.

  - **HEADERS DICT** : `dict(resp.headers)` aplatit les multi-headers
    httpx. Pour les headers répétés (Set-Cookie, etc.), seule la
    dernière valeur subsiste — c'est un compromis assumé Jour-1.

  - **HTTP_MAX_BYTES = 1 MiB** : valeur de référence à verrouiller pour
    éviter une bump silencieuse à 100 MiB qui rendrait le tool OOM-able.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tools.config import get_settings
from tools.registry.builtins import _http_get


def _mount_mock(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport) -> None:
    class _MockClient(httpx.AsyncClient):
        def __init__(self, **_: Any) -> None:
            super().__init__(transport=transport)

    monkeypatch.setattr('tools.registry.builtins.httpx.AsyncClient', _MockClient)


class TestStatusPassthrough:
    @pytest.mark.asyncio
    async def test_404_returned_not_raised(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # CRITIQUE : si on raise sur 404, le LLM ne peut plus utiliser
        # http_get pour vérifier l'existence d'une page.
        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(404, content=b'Not Found')

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/missing'})
        assert result['status'] == 404
        assert result['body'] == 'Not Found'

    @pytest.mark.asyncio
    async def test_500_returned_not_raised(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, content=b'oops')

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        assert result['status'] == 500

    @pytest.mark.asyncio
    async def test_302_returned_not_followed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # follow_redirects=False déjà testé via captured kwargs. Ici on
        # verrouille le comportement OBSERVABLE : 302 est retourné tel
        # quel au caller, pas suivi.
        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={'location': 'https://evil.example/'})

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        assert result['status'] == 302
        assert result['headers']['location'] == 'https://evil.example/'


class TestUtf8Robustness:
    @pytest.mark.asyncio
    async def test_invalid_utf8_replaced_not_raised(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Octets 0xff 0xfe sont invalides en UTF-8. `errors='replace'`
        # doit produire des caractères U+FFFD, pas raise UnicodeDecodeError.
        bad_bytes = b'hello\xff\xfeworld'

        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=bad_bytes)

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        # decode succeeded, returned a string with replacement chars
        assert isinstance(result['body'], str)
        assert 'hello' in result['body']
        assert 'world' in result['body']
        # \ufffd = caractère de remplacement Unicode
        assert '\ufffd' in result['body']

    @pytest.mark.asyncio
    async def test_pure_binary_content_does_not_raise(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Cas réaliste : le LLM tente un http_get sur une URL qui sert
        # accidentellement du JPEG ou du PDF. Doit retourner SANS raise.
        binary = bytes(range(256))

        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=binary)

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/blob'})
        assert result['status'] == 200
        assert isinstance(result['body'], str)


class TestTruncationBoundary:
    @pytest.mark.asyncio
    async def test_exactly_max_bytes_not_truncated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Vérouille `>` (strict), pas `>=`. Si quelqu'un changeait en
        # `>=`, un body exactement à la taille MAX serait marqué
        # truncated alors qu'il est complet.
        max_bytes = get_settings().HTTP_MAX_BYTES
        exact = b'a' * max_bytes

        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=exact)

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        assert len(result['body']) == max_bytes
        assert result['truncated'] is False

    @pytest.mark.asyncio
    async def test_max_plus_one_byte_is_truncated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Symétrique au cas exact : un seul octet de trop déclenche
        # truncated. Pas besoin de +100 comme dans le test existant.
        max_bytes = get_settings().HTTP_MAX_BYTES
        over = b'a' * (max_bytes + 1)

        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=over)

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        assert len(result['body']) == max_bytes
        assert result['truncated'] is True


class TestEmptyBody:
    @pytest.mark.asyncio
    async def test_empty_body_returns_empty_string_not_truncated(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Cas réel : 204 No Content, ou HEAD-like. body='' et
        # truncated=False (pas de division par zéro implicite).
        def _handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b'')

        _mount_mock(monkeypatch, httpx.MockTransport(_handler))
        result = await _http_get({'url': 'https://example.com/'})
        assert result['body'] == ''
        assert result['truncated'] is False


class TestSettingsContract:
    def test_http_max_bytes_default_is_one_mib(self) -> None:
        # Verrouille la valeur Jour-1. Bump silencieux à 100 MiB
        # rendrait le tool OOM-able quand le LLM ciblerait des CDN
        # avec gros payloads.
        assert get_settings().HTTP_MAX_BYTES == 1_048_576

    def test_tool_timeout_is_short(self) -> None:
        # Verrou pragmatique : le timeout doit rester court (< 30s)
        # pour ne pas bloquer le worker gRPC sur une URL lente.
        assert get_settings().TOOL_TIMEOUT_S < 30
