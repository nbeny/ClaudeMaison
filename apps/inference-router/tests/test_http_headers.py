"""Caractérisation forwarding des headers HTTP — inference-router.

Le proxy /v1/* fait un filtrage NON-TRIVIAL des headers entre le caller et
le backend. Cette logique est SÉCURITAIRE et silencieuse : si elle casse,
rien ne plante au runtime mais on a une fuite de credentials.

Invariants verrouillés ici :

  1. **Authorization entrante STRIPPED**. Le caller du proxy (Keycloak →
     edge-api → inference-router) envoie son propre Bearer JWT. Ce token
     n'a aucun sens pour le backend (vLLM, OpenRouter, etc.) et le forwarder
     vers OpenRouter serait une FUITE de credential utilisateur.

  2. **Authorization injectée APRÈS strip**, depuis `api_key_env`. Donc
     le backend voit `Bearer <env_value>`, jamais `Bearer <user_jwt>`.
     Si quelqu'un retire 'authorization' du set de strip, le user JWT
     écrase la clé backend → 401 silencieux + leak.

  3. **Host / Content-Length STRIPPED**. httpx les recalcule. Forwarder
     le Host du caller (`router.test`) au backend (`vllm.test`) crée
     des Host mismatch côté backend. Forwarder un Content-Length
     verbatim invalide la requête si le body est ré-encodé.

  4. **Autres headers (X-Forwarded-For, X-Request-Id, X-Trace-Id, etc.)
     PASS-THROUGH**. Sinon on perd la correlation distribuée et
     l'observability casse à la première hop interne.

  5. **Per-pick isolation du Bearer**. `_build_headers` fait `dict(base)`
     AVANT d'injecter le Bearer. Si on mutait `base` directement, le
     token du primary leakerait vers le fallback (et inversement).
     C'est subtil : un attaquant qui contrôle un faux backend en
     position fallback pourrait lire le token destiné au primary.
"""

from __future__ import annotations

from collections.abc import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from inference_router.config import BackendConfig
from inference_router.http import create_app
from inference_router.router import BackendRouter


def _build_client(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport, timeout=5.0)


def _capture_app(
    backends: dict[str, list[BackendConfig]],
    seen: list[httpx.Request],
    response: httpx.Response | None = None,
) -> TestClient:
    """App qui capture chaque request vue par le backend.

    Par défaut, renvoie 200/{ok: true}. On peut surcharger pour simuler
    une erreur réseau.
    """

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if response is not None:
            return response
        return httpx.Response(200, json={'ok': True})

    router = BackendRouter(backends)
    client = _build_client(handler)
    return TestClient(create_app(router=router, http_client=client))


class TestIncomingAuthorizationStripped:
    """Le Bearer du caller ne doit JAMAIS sortir vers le backend."""

    def test_incoming_authorization_is_stripped_when_no_api_key_env(self) -> None:
        # SÉCURITÉ : sans api_key_env, le backend reçoit ZÉRO Authorization.
        # Si on retirait 'authorization' du set strip, le caller-jwt
        # serait forwardé tel quel → fuite.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            headers={'Authorization': 'Bearer USER-JWT-SECRET'},
            json={'model': 'm', 'messages': []},
        )
        assert len(seen) == 1
        assert seen[0].headers.get('authorization') is None

    def test_incoming_authorization_does_not_leak_when_api_key_env_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Le backend a son propre api_key_env. Le caller envoie son JWT.
        # Le backend DOIT voir `Bearer <env>`, JAMAIS `Bearer USER-JWT`.
        monkeypatch.setenv('VLLM_KEY', 'sk-backend')
        seen: list[httpx.Request] = []
        client = _capture_app(
            {
                'm': [
                    BackendConfig(
                        url='http://vllm.test:8000', api_key_env='VLLM_KEY'
                    )
                ]
            },
            seen,
        )
        client.post(
            '/v1/chat/completions',
            headers={'Authorization': 'Bearer USER-JWT-SECRET'},
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('authorization') == 'Bearer sk-backend'

    def test_authorization_case_insensitive_strip(self) -> None:
        # Les headers HTTP sont case-insensitive. Le strip check fait
        # `.lower()` donc 'AUTHORIZATION' / 'Authorization' / 'authorization'
        # doivent TOUS être strippés.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            headers={'AUTHORIZATION': 'Bearer LEAK'},
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('authorization') is None


class TestHostAndContentLengthStripped:
    def test_host_header_not_forwarded_verbatim(self) -> None:
        # Le TestClient envoie Host: testserver. Le backend recevra
        # Host: vllm.test:8000 (recalculé par httpx) — JAMAIS testserver.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': []},
        )
        host = seen[0].headers.get('host')
        assert host != 'testserver'
        assert host == 'vllm.test:8000'

    def test_content_length_not_forwarded_verbatim(self) -> None:
        # httpx recalcule Content-Length depuis le body sérialisé. Si on
        # forwardait une valeur du caller, on aurait des invalid requests
        # silencieux côté backend dès qu'un proxy intermédiaire
        # re-sérialise le JSON.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        # On envoie un faux Content-Length. Le backend doit voir la
        # vraie taille du body, calculée par httpx.
        client.post(
            '/v1/chat/completions',
            headers={'Content-Length': '99999'},
            json={'model': 'm', 'messages': []},
        )
        cl = seen[0].headers.get('content-length')
        assert cl != '99999'
        # Doit correspondre à la longueur effective du body sérialisé.
        assert cl == str(len(seen[0].content))


class TestPassThroughHeaders:
    def test_x_request_id_is_forwarded(self) -> None:
        # CRITIQUE pour observability : sans X-Request-Id forwardé, on
        # perd la corrélation distribuée entre router → backend dans
        # les logs OTel.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            headers={'X-Request-Id': 'req-abc-123'},
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('x-request-id') == 'req-abc-123'

    def test_x_forwarded_for_is_forwarded(self) -> None:
        # Permet au backend de logger l'IP du client réel (si politique
        # d'audit le requiert) plutôt que l'IP du router.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            headers={'X-Forwarded-For': '10.0.0.42'},
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('x-forwarded-for') == '10.0.0.42'

    def test_arbitrary_custom_header_is_forwarded(self) -> None:
        seen: list[httpx.Request] = []
        client = _capture_app(
            {'m': [BackendConfig(url='http://vllm.test:8000')]}, seen
        )
        client.post(
            '/v1/chat/completions',
            headers={'X-Custom-Trace': 'trace=xyz'},
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('x-custom-trace') == 'trace=xyz'


class TestPerPickBearerIsolation:
    """Le token injecté pour le pick N ne doit pas leak vers le pick N+1."""

    def test_primary_token_does_not_leak_to_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Primary a api_key_env=KEY_A, fallback a api_key_env=KEY_B.
        # Primary tombe en ConnectError. Le fallback DOIT voir KEY_B,
        # JAMAIS KEY_A. C'est ce que garantit `dict(base)` dans
        # _build_headers : la mutation ne touche que la copie per-pick.
        monkeypatch.setenv('KEY_A', 'sk-primary')
        monkeypatch.setenv('KEY_B', 'sk-fallback')
        seen: list[tuple[str, str | None]] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append((req.url.host, req.headers.get('authorization')))
            if req.url.host == 'primary.test':
                raise httpx.ConnectError('down', request=req)
            return httpx.Response(200, json={'ok': True})

        router = BackendRouter(
            {
                'm': [
                    BackendConfig(
                        url='http://primary.test:8000',
                        priority=0,
                        api_key_env='KEY_A',
                    ),
                    BackendConfig(
                        url='http://fallback.test:8000',
                        priority=1,
                        api_key_env='KEY_B',
                    ),
                ]
            }
        )
        http_client = _build_client(handler)
        client = TestClient(create_app(router=router, http_client=http_client))
        res = client.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': []},
        )
        assert res.status_code == 200
        assert seen == [
            ('primary.test', 'Bearer sk-primary'),
            ('fallback.test', 'Bearer sk-fallback'),
        ]

    def test_fallback_without_api_key_sees_no_authorization_after_primary_with_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Inverse : primary AVEC api_key, fallback SANS. Si la mutation
        # in-place de `base` existait, le fallback verrait le Bearer du
        # primary. Test : fallback doit voir Authorization=None.
        monkeypatch.setenv('KEY_A', 'sk-primary')
        seen: list[tuple[str, str | None]] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append((req.url.host, req.headers.get('authorization')))
            if req.url.host == 'primary.test':
                raise httpx.ConnectError('down', request=req)
            return httpx.Response(200, json={'ok': True})

        router = BackendRouter(
            {
                'm': [
                    BackendConfig(
                        url='http://primary.test:8000',
                        priority=0,
                        api_key_env='KEY_A',
                    ),
                    BackendConfig(
                        url='http://fallback.test:8000',
                        priority=1,
                    ),
                ]
            }
        )
        http_client = _build_client(handler)
        client = TestClient(create_app(router=router, http_client=http_client))
        client.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': []},
        )
        assert seen[0] == ('primary.test', 'Bearer sk-primary')
        # Le fallback ne doit voir AUCUN Bearer — même pas celui du primary.
        assert seen[1] == ('fallback.test', None)

    def test_missing_env_var_does_not_inject_empty_bearer(self) -> None:
        # Si api_key_env pointe sur une variable NON définie, on ne doit
        # PAS envoyer `Bearer ` (avec valeur vide). Le `if key:` côté
        # _build_headers gère ce cas. Sinon le backend voit un Bearer
        # vide et répond 401 sans diagnostic clair.
        seen: list[httpx.Request] = []
        client = _capture_app(
            {
                'm': [
                    BackendConfig(
                        url='http://vllm.test:8000',
                        api_key_env='UNDEFINED_KEY_VAR_XYZ',
                    )
                ]
            },
            seen,
        )
        client.post(
            '/v1/chat/completions',
            json={'model': 'm', 'messages': []},
        )
        assert seen[0].headers.get('authorization') is None
