# Phase 1 — Walking Skeleton Chat (M1-M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer un chat fonctionnel bout-en-bout : un utilisateur authentifié envoie un message via le frontend Next.js, edge-api persiste la conversation et délègue à ai-core, ai-core streame la réponse via NATS, realtime relaie en SSE au navigateur. Pas de RAG, pas de tools, pas de mémoire L3 — juste le squelette.

**Architecture:**
- `apps/web` (Next.js 15) → mutation GraphQL `sendMessage` → `edge-api` persiste msg user, appelle HTTP `ai-core` (fire-and-forget), retourne `{conversationId, messageId}`.
- `ai-core` lit le contexte de la conversation, appelle `inference-router` en streaming OpenAI-compatible, publie chaque token sur `events.<conversationId>` (NATS), persiste le message assistant à la fin.
- `inference-router` route vers backends primaires (llama.cpp local) avec fallback automatique vers Mistral API si timeout/5xx.
- `realtime` souscrit à `events.>`, relaie en SSE sur `GET /sse/v1/conversations/:id/stream`. WS conservé pour usage futur (voice mode).
- `apps/web` consomme le SSE via `EventSource` natif.

**Tech Stack:** Python 3.13 (FastAPI + httpx + pydantic-settings) pour `inference-router`/`ai-core` ; TypeScript 5.7 (Fastify + nats.js) pour `realtime` ; NestJS 11 + Drizzle + Atlas pour `edge-api` ; Next.js 15 + GraphQL Codegen pour `apps/web` ; llama.cpp server (ROCm) + Mistral API (fallback) pour l'inférence ; NATS Core (best-effort) pour le streaming token.

**Pré-requis avant Task 1 :**
- Setup ROCm sur Kali (~1 semaine si pas encore fait) — non bloquant pour les Tasks 1-7 qui n'ont pas besoin de GPU.
- Variable d'env `MISTRAL_API_KEY` disponible dans `.env.local` (compte Mistral créé, sovereign EU).
- Docker compose stack OIDC (Keycloak) opérationnel via `make compose-up PROFILES=oidc,ai,obs`.

---

## Bloc A — Architecture Decision Records

### Task 1 : Réécrire ADR-0006 (runtime LLM)

**Files:**
- Modify: `docs/adr/0006-runtime-llm.md`

**Pourquoi :** L'ADR-0006 actuel choisit vLLM (CUDA-first). Avec un GPU AMD RDNA2 16 Go, vLLM/ROCm est expérimental et instable sur gfx1030. On bascule sur llama.cpp server (OpenAI-compatible, ROCm mature) en backend principal + Mistral API en fallback pour les modèles impossibles localement.

- [ ] **Step 1 : Lire l'ADR existant**

Run: `cat docs/adr/0006-runtime-llm.md`
Note la décision actuelle et le statut (`Accepted` probablement).

- [ ] **Step 2 : Réécrire intégralement l'ADR**

Remplacer le contenu par :

```markdown
# ADR-0006 — Runtime LLM auto-hébergé : llama.cpp server + fallback Mistral API

**Statut :** Accepted (révisé 2026-05-27)
**Supersedes :** version vLLM-first du 2026-XX-XX

## Contexte

Le projet exige une inférence souveraine (pas de cloud US dans le chemin de requête). Le hardware de dev est un AMD Radeon RX 6900 XT 16 Go (RDNA2 / gfx1030). vLLM cible CUDA en priorité ; son support ROCm est expérimental sur RDNA2 et casse à chaque release majeure. Les modèles > 22B en Q4 dépassent la VRAM disponible.

## Décision

1. **Backend principal local :** `llama.cpp` (serveur OpenAI-compatible, binaire `server`), compilé avec `LLAMA_HIPBLAS=1` pour ROCm. Quantization GGUF Q4_K_M par défaut.
2. **Fallback EU souverain :** Mistral API (Mistral AI, FR) pour les modèles > 14B ou en cas d'indisponibilité locale. Mistral est dans l'UE → respecte la contrainte non-négociable de souveraineté.
3. **Routing :** assuré par `inference-router` (cf. ADR-0013). Chaque entrée du catalogue déclare `primary` (llama.cpp) et `fallback` (Mistral) optionnels.
4. **Modèles cibles MVP :**
   - `qwen2.5-coder-7b-q4` (llama.cpp local) — chat code par défaut
   - `mistral-7b-instruct-q4` (llama.cpp local) — chat général
   - `mistral-large-latest` (Mistral API) — tâches lourdes / fallback

## Conséquences

- **Positives :** stack stable sur Kali Linux, souveraineté préservée (Mistral = EU), pas de dépendance CUDA.
- **Négatives :** llama.cpp single-process (pas de batch concurrent natif comme vLLM) → throughput limité. Acceptable pour solo/MVP.
- **Migration vers vLLM-ROCm** rouverte si AMD stabilise gfx1030 ou si on bascule sur un GPU CDNA/RDNA3 supporté.
```

- [ ] **Step 3 : Commit**

```bash
git add docs/adr/0006-runtime-llm.md
git commit -m "docs(adr): réécrire 0006 — llama.cpp + Mistral fallback (AMD RDNA2)"
```

---

### Task 2 : Nouvel ADR-0013 — Stratégie de routage inference-router

**Files:**
- Create: `docs/adr/0013-inference-routing.md`

- [ ] **Step 1 : Créer le fichier ADR**

```markdown
# ADR-0013 — Stratégie de routage `inference-router`

**Statut :** Accepted (2026-05-27)

## Contexte

`inference-router` doit pouvoir : (1) servir plusieurs backends OpenAI-compatibles pour un même modèle logique (load-balancing), (2) basculer automatiquement vers un fallback distant (Mistral API) si le backend primaire échoue, (3) propager le streaming OpenAI sans tampon intermédiaire.

## Décision

1. **Configuration par modèle** : chaque modèle logique a une liste de backends, chacun avec un `priority` (entier ; `0` = priorité la plus haute) :
   ```yaml
   # MODEL_BACKENDS_YAML (monté en config map)
   mistral-7b-instruct-q4:
     - url: http://llama-cpp-1:8080      # primaire
       priority: 0
     - url: http://llama-cpp-2:8080      # peer du primaire (round-robin)
       priority: 0
     - url: https://api.mistral.ai       # fallback si tous les locaux KO
       priority: 1
       api_key_env: MISTRAL_API_KEY
   ```
2. **Algorithme** : round-robin parmi les backends de plus haute priorité (`priority` le plus bas). Si tous échouent (timeout ou 5xx) → descendre d'un cran. Si la dernière priorité échoue → 503 au client.
3. **Détection d'échec** : `httpx.ReadTimeout`, `httpx.ConnectError`, ou réponse HTTP ≥ 500. Les 4xx remontent telles quelles (erreur client).
4. **Streaming** : on proxy le flux SSE de l'amont vers l'aval token-par-token sans bufferisation. Si l'amont stream et tombe en milieu de génération, on n'essaie pas de basculer le fallback (le client a déjà reçu des tokens partiels) — on coupe avec un événement `error`.

## Conséquences

- Pour le MVP Phase 1, on garde le format `MODEL_BACKENDS` env string (déjà existant) mais on ajoute `MODEL_BACKENDS_YAML` (fichier monté) qui prend le pas s'il existe. Migration progressive.
- Le routing reste synchrone par requête. Pas de pool persistant côté router : chaque chat completion ouvre une connexion httpx → suffisant à l'échelle solo.
```

- [ ] **Step 2 : Commit**

```bash
git add docs/adr/0013-inference-routing.md
git commit -m "docs(adr): 0013 — stratégie de routage inference-router (primary + fallback)"
```

---

## Bloc B — Schéma base de données

### Task 3 : Ajouter schéma `conversations` à `schema.sql`

**Files:**
- Modify: `infrastructure/db/schema.sql` (append à la fin)
- Test: pas de test unitaire — vérification via Atlas dry-run en Task 4

**Pourquoi :** edge-api est le seul détenteur des données utilisateur. Le schéma `conversations` (tables `conversations` + `messages`) appartient au binaire edge-api comme `auth` et `billing`. ai-core lit/écrit via les endpoints HTTP de edge-api, **pas** en direct dans la DB.

- [ ] **Step 1 : Ajouter le schéma + tables à la fin de `schema.sql`**

Append au fichier :

```sql
-- ===========================================================================
-- Schéma "conversations" — propriété de edge-api (lectures/écritures via
-- mutations GraphQL ou endpoints HTTP exposés à ai-core).
-- ===========================================================================
CREATE SCHEMA IF NOT EXISTS conversations;

-- conversations.conversations
CREATE TABLE conversations.conversations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES auth.workspaces(id) ON DELETE CASCADE,
    created_by   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    title        TEXT,
    model        TEXT,  -- snapshot du modèle utilisé au démarrage (nullable si pas encore fixé)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ
);

CREATE INDEX conversations_workspace_idx
    ON conversations.conversations (workspace_id, updated_at DESC)
    WHERE deleted_at IS NULL;

-- conversations.messages
-- Une conversation est une suite ordonnée de messages. On stocke le contenu en
-- TEXT brut (markdown côté UI) ; les éventuels tool_calls vivront en JSONB
-- quand on ajoutera les tools (Phase 3).
CREATE TABLE conversations.messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations.conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content         TEXT NOT NULL DEFAULT '',
    finish_reason   TEXT,  -- 'stop' | 'length' | 'tool_call' | 'error' | NULL si en cours
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_idx
    ON conversations.messages (conversation_id, created_at);
```

- [ ] **Step 2 : Vérifier la cohérence syntaxique**

Run: `grep -n "CREATE SCHEMA\|CREATE TABLE conversations" infrastructure/db/schema.sql`
Expected: les nouvelles déclarations apparaissent et `CREATE SCHEMA IF NOT EXISTS conversations;` est présent.

- [ ] **Step 3 : Commit**

```bash
git add infrastructure/db/schema.sql
git commit -m "feat(db): schéma conversations (tables conversations + messages)"
```

---

### Task 4 : Générer la migration Atlas

**Files:**
- Create: `infrastructure/db/migrations/<timestamp>_conversations_schema.sql` (généré)
- Modify: `infrastructure/db/migrations/atlas.sum` (généré)

- [ ] **Step 1 : Lancer Atlas pour générer la migration**

Run: `make db-diff NAME=conversations_schema`

Si la commande `make db-diff` n'existe pas, vérifier le Makefile racine puis utiliser directement :
```bash
atlas migrate diff conversations_schema \
  --dir "file://infrastructure/db/migrations" \
  --to "file://infrastructure/db/schema.sql" \
  --dev-url "docker://postgres/16/test?search_path=public"
```
Expected: un nouveau fichier `<timestamp>_conversations_schema.sql` créé sous `infrastructure/db/migrations/`.

- [ ] **Step 2 : Inspecter la migration générée**

Run: `ls -1t infrastructure/db/migrations/ | head -3 && cat $(ls -1t infrastructure/db/migrations/*.sql | head -1)`
Vérifier qu'on a `CREATE SCHEMA conversations`, les deux `CREATE TABLE`, et les deux index. Aucune autre modification (pas de drift sur auth/billing).

- [ ] **Step 3 : Appliquer en local et vérifier**

Run:
```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile oidc up -d postgres
atlas migrate apply --dir "file://infrastructure/db/migrations" \
  --url "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable"
```
Expected: `OK` sur la nouvelle migration.

Run: `docker compose exec postgres psql -U postgres -d postgres -c "\dt conversations.*"`
Expected: les tables `conversations.conversations` et `conversations.messages` apparaissent.

- [ ] **Step 4 : Commit**

```bash
git add infrastructure/db/migrations/
git commit -m "feat(db): migration Atlas pour le schéma conversations"
```

---

## Bloc C — `inference-router` : fallback automatique

### Task 5 : Spec — formaliser le contrat de fallback

**Files:**
- Modify: `docs/specs/inference-router/design.md` (créer si absent)

**Pourquoi :** verrouiller le comportement attendu avant d'écrire les tests.

- [ ] **Step 1 : Créer / mettre à jour le doc design**

Contenu minimal à garantir dans `docs/specs/inference-router/design.md` :

```markdown
# inference-router — Design

## Routage avec fallback

Source de vérité : ADR-0013.

### Configuration

Format préféré (Phase 1) — `MODEL_BACKENDS` env string :
```
mistral-7b-instruct-q4=http://llama-cpp-1:8080,http://llama-cpp-2:8080;mistral-large-latest=mistral:https://api.mistral.ai|env:MISTRAL_API_KEY
```
- Séparateur de modèles : `;`
- Séparateur d'entrées : `=` (model=backends)
- Séparateur de backends : `,`
- Préfixe optionnel `<provider>:` (par défaut `llama-cpp`)
- Suffixe optionnel `|env:<VAR>` pour injecter un Bearer token

### Algorithme

1. Backends groupés par `priority` (0 = primaire). Round-robin **dans** chaque groupe.
2. Sur échec (`ConnectError`, `ReadTimeout`, ou HTTP ≥ 500) → essayer le prochain backend du même groupe ; si tous épuisés → groupe suivant.
3. En streaming : aucun fallback en cours de stream (le client a déjà reçu des tokens). Couper avec un event `error`.
4. Toutes les tentatives échouent → HTTP 503 avec body `{error: "all_backends_failed", attempts: N}`.
```

- [ ] **Step 2 : Commit**

```bash
git add docs/specs/inference-router/design.md
git commit -m "docs(inference-router): formaliser le contrat de fallback (priority + groupes)"
```

---

### Task 6 : Refactor `MODEL_BACKENDS` pour supporter priorité + provider

**Files:**
- Modify: `apps/inference-router/src/inference_router/config.py`
- Modify: `apps/inference-router/src/inference_router/router.py`
- Test: `apps/inference-router/tests/test_router.py` (créer ou étendre)
- Test: `apps/inference-router/tests/test_config.py`

- [ ] **Step 1 : Écrire le test de parsing étendu**

Ajouter dans `apps/inference-router/tests/test_config.py` (créer le fichier si absent) :

```python
"""Tests parse_model_backends — format Phase 1 avec provider/priority/auth."""

from __future__ import annotations

import pytest

from inference_router.config import BackendConfig, parse_model_backends


def test_parse_simple_url_defaults_to_llama_cpp() -> None:
    out = parse_model_backends('m1=http://x:8080')
    assert out == {
        'm1': [BackendConfig(url='http://x:8080', provider='llama-cpp', priority=0, api_key_env=None)]
    }


def test_parse_multiple_backends_same_priority() -> None:
    out = parse_model_backends('m1=http://a,http://b')
    assert len(out['m1']) == 2
    assert {b.url for b in out['m1']} == {'http://a', 'http://b'}
    assert all(b.priority == 0 for b in out['m1'])


def test_parse_provider_prefix_and_api_key() -> None:
    spec = 'big=mistral:https://api.mistral.ai|env:MISTRAL_API_KEY'
    out = parse_model_backends(spec)
    assert out['big'][0].provider == 'mistral'
    assert out['big'][0].api_key_env == 'MISTRAL_API_KEY'
    assert out['big'][0].url == 'https://api.mistral.ai'


def test_parse_priority_via_pipe() -> None:
    # Format : url|prio:N
    out = parse_model_backends('m=http://primary|prio:0,http://fallback|prio:1')
    by_prio = {b.url: b.priority for b in out['m']}
    assert by_prio == {'http://primary': 0, 'http://fallback': 1}


def test_parse_rejects_empty_url() -> None:
    with pytest.raises(ValueError):
        parse_model_backends('m=')
```

- [ ] **Step 2 : Lancer le test pour vérifier l'échec**

Run: `cd apps/inference-router && uv run pytest tests/test_config.py -v`
Expected: FAIL — `BackendConfig` n'existe pas encore.

- [ ] **Step 3 : Implémenter `BackendConfig` et le nouveau parser**

Modifier `apps/inference-router/src/inference_router/config.py` (remplacer `parse_model_backends` et ajouter `BackendConfig`) :

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class BackendConfig:
    url: str
    provider: str = 'llama-cpp'
    priority: int = 0
    api_key_env: str | None = None


def _parse_single_backend(raw: str) -> BackendConfig:
    """Parse "[provider:]url[|prio:N][|env:VAR]" en BackendConfig."""
    raw = raw.strip()
    if not raw:
        raise ValueError('empty backend entry')

    # Découper les options suffixes (|prio:N, |env:VAR)
    parts = raw.split('|')
    head = parts[0]
    options = parts[1:]

    # Provider optionnel (préfixe "name:" SI ce n'est pas un schéma http(s))
    provider = 'llama-cpp'
    url = head
    if ':' in head:
        candidate_provider, rest = head.split(':', 1)
        if candidate_provider not in ('http', 'https'):
            provider = candidate_provider
            url = rest

    if not url:
        raise ValueError(f'no URL in backend entry: {raw!r}')

    priority = 0
    api_key_env: str | None = None
    for opt in options:
        key, _, value = opt.partition(':')
        if key == 'prio':
            priority = int(value)
        elif key == 'env':
            api_key_env = value
        else:
            raise ValueError(f'unknown backend option: {opt!r}')

    return BackendConfig(url=url, provider=provider, priority=priority, api_key_env=api_key_env)


def parse_model_backends(spec: str) -> dict[str, list[BackendConfig]]:
    result: dict[str, list[BackendConfig]] = {}
    if not spec:
        return result
    for entry in spec.split(';'):
        entry = entry.strip()
        if not entry:
            continue
        if '=' not in entry:
            raise ValueError(f'invalid MODEL_BACKENDS entry: {entry!r}')
        name, urls = entry.split('=', 1)
        backends = [_parse_single_backend(u) for u in urls.split(',') if u.strip()]
        if not backends:
            raise ValueError(f'no backends for model: {name!r}')
        result[name.strip()] = backends
    return result
```

- [ ] **Step 4 : Lancer le test, vérifier qu'il passe**

Run: `cd apps/inference-router && uv run pytest tests/test_config.py -v`
Expected: PASS.

- [ ] **Step 5 : Adapter le `BackendRouter`**

Remplacer `apps/inference-router/src/inference_router/router.py` :

```python
"""Routing par modèle avec groupes de priorité et fallback."""

from __future__ import annotations

import itertools
import threading
from collections.abc import Iterator
from dataclasses import dataclass

from inference_router.config import BackendConfig


@dataclass(frozen=True, slots=True)
class BackendPick:
    """Backend choisi pour une tentative + identifiant de groupe pour le fallback."""

    backend: BackendConfig
    group_index: int


class BackendRouter:
    """Tient un round-robin par groupe de priorité, pour chaque modèle."""

    def __init__(self, model_backends: dict[str, list[BackendConfig]]) -> None:
        # On range les backends par priorité croissante puis on regroupe.
        self._groups: dict[str, list[list[BackendConfig]]] = {}
        self._cycles: dict[tuple[str, int], Iterator[BackendConfig]] = {}
        for model, backends in model_backends.items():
            ordered = sorted(backends, key=lambda b: b.priority)
            groups: list[list[BackendConfig]] = []
            for _, items in itertools.groupby(ordered, key=lambda b: b.priority):
                group = list(items)
                groups.append(group)
            self._groups[model] = groups
            for idx, group in enumerate(groups):
                self._cycles[(model, idx)] = itertools.cycle(group)
        self._lock = threading.Lock()

    def models(self) -> list[str]:
        return sorted(self._groups.keys())

    def attempts(self, model: str) -> list[BackendPick]:
        """Ordre des tentatives à essayer pour un modèle : un pick par groupe.

        Round-robin DANS chaque groupe via le cycle partagé ; les groupes sont
        parcourus en ordre de priorité croissant.
        """
        groups = self._groups.get(model)
        if groups is None:
            raise KeyError(model)
        picks: list[BackendPick] = []
        with self._lock:
            for idx, _ in enumerate(groups):
                cycle = self._cycles[(model, idx)]
                picks.append(BackendPick(backend=next(cycle), group_index=idx))
        return picks
```

- [ ] **Step 6 : Tests du router**

Créer/remplacer `apps/inference-router/tests/test_router.py` :

```python
"""Tests BackendRouter — priorité + round-robin."""

from __future__ import annotations

import pytest

from inference_router.config import BackendConfig
from inference_router.router import BackendRouter


def _bc(url: str, prio: int = 0) -> BackendConfig:
    return BackendConfig(url=url, priority=prio)


def test_attempts_returns_one_pick_per_priority_group() -> None:
    router = BackendRouter({
        'm': [_bc('http://a', 0), _bc('http://b', 0), _bc('http://c', 1)]
    })
    picks = router.attempts('m')
    assert len(picks) == 2
    assert picks[0].group_index == 0
    assert picks[1].group_index == 1
    assert picks[0].backend.url in {'http://a', 'http://b'}
    assert picks[1].backend.url == 'http://c'


def test_round_robin_within_same_priority() -> None:
    router = BackendRouter({'m': [_bc('http://a'), _bc('http://b')]})
    seen = {router.attempts('m')[0].backend.url for _ in range(4)}
    # Au moins une fois chaque sur 4 tirages.
    assert seen == {'http://a', 'http://b'}


def test_unknown_model_raises() -> None:
    router = BackendRouter({'m': [_bc('http://a')]})
    with pytest.raises(KeyError):
        router.attempts('does-not-exist')
```

Run: `cd apps/inference-router && uv run pytest tests/test_router.py -v`
Expected: PASS.

- [ ] **Step 7 : Adapter `http.py` pour utiliser `attempts()`**

Modifier `apps/inference-router/src/inference_router/http.py` — sur chaque requête, appeler `router.attempts(model)`, essayer les backends dans l'ordre, court-circuiter dès qu'on reçoit un statut < 500. Pour le streaming, ne tenter le fallback **qu'avant** la première écriture vers le client. Code de la boucle principale (extrait à intégrer dans le handler existant) :

```python
from inference_router.router import BackendPick

async def _try_backend(client: httpx.AsyncClient, pick: BackendPick, body: bytes, path: str) -> httpx.Response | None:
    """Tente une requête ; retourne la Response si status < 500, sinon None."""
    headers = {}
    if pick.backend.api_key_env:
        import os
        key = os.environ.get(pick.backend.api_key_env)
        if key:
            headers['Authorization'] = f'Bearer {key}'
    try:
        resp = await client.post(
            pick.backend.url.rstrip('/') + path,
            content=body,
            headers=headers,
            timeout=settings.BACKEND_TIMEOUT_S,
        )
    except (httpx.ConnectError, httpx.ReadTimeout):
        return None
    if resp.status_code >= 500:
        return None
    return resp
```

Le handler `/v1/chat/completions` itère sur `router.attempts(model)`, retourne dès que `_try_backend` renvoie une réponse non nulle, et renvoie HTTP 503 si tout échoue.

- [ ] **Step 8 : Commit**

```bash
git add apps/inference-router/src/ apps/inference-router/tests/
git commit -m "feat(inference-router): priority groups + fallback automatique sur erreurs réseau/5xx"
```

---

### Task 7 : Test d'intégration du fallback via httpx.MockTransport

**Files:**
- Test: `apps/inference-router/tests/test_fallback_integration.py` (créer)

- [ ] **Step 1 : Écrire le test**

```python
"""Test d'intégration : un backend primaire qui timeout doit basculer sur le fallback."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from inference_router.config import BackendConfig
from inference_router.http import create_app
from inference_router.router import BackendRouter


@pytest.fixture
def app_with_fallback(monkeypatch: pytest.MonkeyPatch):
    call_log: list[str] = []

    def primary_handler(req: httpx.Request) -> httpx.Response:
        call_log.append('primary')
        raise httpx.ConnectError('boom')

    def fallback_handler(req: httpx.Request) -> httpx.Response:
        call_log.append('fallback')
        return httpx.Response(
            200,
            json={
                'model': 'm',
                'choices': [{'message': {'content': 'hi from fallback'}, 'finish_reason': 'stop'}],
            },
        )

    # Le client httpx interne doit router selon l'URL appelée.
    def dispatch(req: httpx.Request) -> httpx.Response:
        host = req.url.host
        if host == 'primary':
            return primary_handler(req)
        if host == 'fallback':
            return fallback_handler(req)
        return httpx.Response(404)

    transport = httpx.MockTransport(dispatch)
    router = BackendRouter({
        'm': [
            BackendConfig(url='http://primary', priority=0),
            BackendConfig(url='http://fallback', priority=1),
        ]
    })
    app = create_app(router=router, http_client=httpx.AsyncClient(transport=transport))
    return TestClient(app), call_log


def test_primary_timeout_falls_back(app_with_fallback) -> None:
    client, call_log = app_with_fallback
    resp = client.post('/v1/chat/completions', json={
        'model': 'm',
        'messages': [{'role': 'user', 'content': 'hi'}],
        'stream': False,
    })
    assert resp.status_code == 200
    assert resp.json()['choices'][0]['message']['content'] == 'hi from fallback'
    assert call_log == ['primary', 'fallback']
```

- [ ] **Step 2 : Lancer le test, vérifier l'échec initial**

Run: `cd apps/inference-router && uv run pytest tests/test_fallback_integration.py -v`
Expected: FAIL — `create_app` n'accepte probablement pas encore `http_client` ou le routing n'utilise pas `attempts()`.

- [ ] **Step 3 : Ajuster `create_app` si nécessaire**

Dans `apps/inference-router/src/inference_router/http.py`, élargir la signature :

```python
def create_app(
    router: BackendRouter | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    ...
```
Et injecter le client dans les handlers (au lieu d'en créer un global).

- [ ] **Step 4 : Lancer le test, vérifier PASS**

Run: `cd apps/inference-router && uv run pytest tests/test_fallback_integration.py -v`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/inference-router/
git commit -m "test(inference-router): intégration fallback primaire→secondaire via MockTransport"
```

---

## Bloc D — `ai-core` : streaming + orchestrateur + endpoint HTTP

### Task 8 : Spec — flux de tokens depuis ai-core

**Files:**
- Modify: `docs/specs/ai-core/design.md` (créer si absent, ajouter section "Streaming Phase 1")

- [ ] **Step 1 : Documenter le contrat de streaming**

Ajouter dans `docs/specs/ai-core/design.md` :

```markdown
## Streaming des tokens (Phase 1)

### Flux

```
client (apps/web)
  └─ EventSource → realtime (SSE)
                     └─ NATS subscribe events.<conversationId>
                                                ↑
                                                │ publish
                              ai-core ──────────┘
                                  │
                                  ├─ httpx stream → inference-router → llama.cpp/Mistral
                                  └─ persist message final → edge-api (HTTP PUT /internal/messages/:id)
```

### Sujets NATS

- `events.<conversationId>` — un event JSON par token ou par évènement de cycle :
  ```json
  {"type": "token", "messageId": "uuid", "delta": "Hel"}
  {"type": "token", "messageId": "uuid", "delta": "lo"}
  {"type": "done",  "messageId": "uuid", "finishReason": "stop", "tokensIn": 42, "tokensOut": 7}
  {"type": "error", "messageId": "uuid", "reason": "all_backends_failed"}
  ```
- Pas de JetStream ; les events sont best-effort. Si le client perd le SSE en plein milieu, le message final est lisible via `GET /chat/{id}` une fois `type=done` persisté côté edge-api.

### Endpoint ai-core

`POST /v1/chat/turn/stream` — appelé par edge-api juste après avoir persisté le message user. Body :
```json
{
  "conversationId": "uuid",
  "workspaceId": "uuid",
  "userId": "uuid",
  "messageId": "uuid",      // message assistant pré-créé par edge-api
  "model": "mistral-7b-instruct-q4",
  "history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```
Réponse : `202 Accepted` immédiat. Tout le streaming sort par NATS.
```

- [ ] **Step 2 : Commit**

```bash
git add docs/specs/ai-core/design.md
git commit -m "docs(ai-core): spec streaming token via NATS + endpoint /v1/chat/turn/stream"
```

---

### Task 9 : `InferenceClient.chat_stream()` (AsyncIterator)

**Files:**
- Modify: `apps/ai-core/src/ai_core/inference/client.py`
- Test: `apps/ai-core/tests/test_inference_stream.py` (créer)

- [ ] **Step 1 : Écrire le test du streaming**

```python
"""Tests chat_stream — parsing du flux SSE OpenAI-compatible via MockTransport."""

from __future__ import annotations

import httpx

from ai_core.inference import InferenceClient
from ai_core.inference.client import ChatMessage


def _build_sse(chunks: list[str], finish_reason: str = 'stop') -> str:
    """Construit une réponse SSE OpenAI-compatible."""
    lines: list[str] = []
    for c in chunks:
        lines.append('data: ' + (
            '{"choices":[{"delta":{"content":"' + c + '"},"finish_reason":null}]}'
        ))
    lines.append('data: ' + (
        '{"choices":[{"delta":{},"finish_reason":"' + finish_reason + '"}]}'
    ))
    lines.append('data: [DONE]')
    return '\n\n'.join(lines) + '\n\n'


async def test_chat_stream_yields_text_deltas() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        # Le client doit avoir demandé stream=True
        import json
        body = json.loads(req.content)
        assert body['stream'] is True
        return httpx.Response(
            200,
            headers={'content-type': 'text/event-stream'},
            content=_build_sse(['Hel', 'lo']).encode(),
        )

    transport = httpx.MockTransport(handler)
    client = InferenceClient(
        base_url='http://router.test/v1',
        api_key='k',
        client=httpx.AsyncClient(transport=transport),
    )
    out: list[tuple[str, str]] = []  # (type, value)
    async for evt in client.chat_stream(model='m', messages=[ChatMessage('user', 'hi')]):
        out.append((evt.type, evt.delta or evt.finish_reason or ''))
    assert ('token', 'Hel') in out
    assert ('token', 'lo') in out
    assert ('done', 'stop') in out
    await client.aclose()
```

- [ ] **Step 2 : Lancer le test, vérifier FAIL**

Run: `cd apps/ai-core && uv run pytest tests/test_inference_stream.py -v`
Expected: FAIL — `chat_stream` et la dataclass d'event n'existent pas.

- [ ] **Step 3 : Implémenter `chat_stream`**

Ajouter dans `apps/ai-core/src/ai_core/inference/client.py` :

```python
from collections.abc import AsyncIterator


@dataclass(slots=True)
class StreamEvent:
    type: Literal['token', 'done', 'error']
    delta: str | None = None
    finish_reason: Literal['stop', 'length', 'tool_call', 'error'] | None = None
    error: str | None = None


class InferenceClient:
    # ... (méthodes existantes inchangées)

    async def chat_stream(
        self,
        *,
        model: str,
        messages: list[ChatMessage],
        temperature: float = 0.7,
        max_tokens: int | None = None,
    ) -> AsyncIterator[StreamEvent]:
        import json

        payload: dict[str, Any] = {
            'model': model,
            'messages': [{'role': m.role, 'content': m.content} for m in messages],
            'temperature': temperature,
            'stream': True,
        }
        if max_tokens is not None:
            payload['max_tokens'] = max_tokens

        headers = {'Authorization': f'Bearer {self._api_key}'} if self._api_key else {}

        try:
            async with self._client.stream(
                'POST',
                f'{self._base_url}/chat/completions',
                json=payload,
                headers=headers,
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    yield StreamEvent(type='error', error=body.decode()[:200])
                    return
                async for line in resp.aiter_lines():
                    if not line.startswith('data:'):
                        continue
                    data = line[len('data:'):].strip()
                    if data == '[DONE]':
                        continue
                    try:
                        evt = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choice = (evt.get('choices') or [{}])[0]
                    delta = (choice.get('delta') or {}).get('content')
                    finish = choice.get('finish_reason')
                    if delta:
                        yield StreamEvent(type='token', delta=delta)
                    if finish:
                        mapped = _FINISH_REASON_MAP.get(finish, 'stop')
                        yield StreamEvent(type='done', finish_reason=mapped)
        except httpx.HTTPError as exc:
            yield StreamEvent(type='error', error=f'network error: {exc}')
```

- [ ] **Step 4 : Exporter `StreamEvent`**

Modifier `apps/ai-core/src/ai_core/inference/__init__.py` :

```python
from ai_core.inference.client import (
    ChatCompletion,
    ChatMessage,
    InferenceClient,
    InferenceError,
    StreamEvent,
)

__all__ = ['ChatCompletion', 'ChatMessage', 'InferenceClient', 'InferenceError', 'StreamEvent']
```

- [ ] **Step 5 : Lancer le test, vérifier PASS**

Run: `cd apps/ai-core && uv run pytest tests/test_inference_stream.py -v`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/ai-core/src/ai_core/inference/ apps/ai-core/tests/test_inference_stream.py
git commit -m "feat(ai-core): InferenceClient.chat_stream() — AsyncIterator de StreamEvent"
```

---

### Task 10 : Publisher NATS dans ai-core

**Files:**
- Create: `apps/ai-core/src/ai_core/events/__init__.py`
- Create: `apps/ai-core/src/ai_core/events/publisher.py`
- Test: `apps/ai-core/tests/test_events_publisher.py`

- [ ] **Step 1 : Vérifier que `nats-py` est dans les dépendances**

Run: `grep nats apps/ai-core/pyproject.toml`
Si absent, ajouter dans `pyproject.toml` section `[project] dependencies` : `"nats-py>=2.7"`.

- [ ] **Step 2 : Écrire le test**

```python
"""Tests EventPublisher — payload, sujet."""

from __future__ import annotations

import json
from typing import Any

import pytest

from ai_core.events import EventPublisher


class _RecordingNats:
    """Faux client NATS qui enregistre les publish."""

    def __init__(self) -> None:
        self.published: list[tuple[str, bytes]] = []

    async def publish(self, subject: str, data: bytes) -> None:
        self.published.append((subject, data))

    async def drain(self) -> None: ...


@pytest.mark.asyncio
async def test_publish_token_serializes_payload() -> None:
    nc = _RecordingNats()
    pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
    await pub.token(conversation_id='c1', message_id='m1', delta='Hi')
    assert len(nc.published) == 1
    subj, data = nc.published[0]
    assert subj == 'events.c1'
    payload: dict[str, Any] = json.loads(data)
    assert payload == {'type': 'token', 'messageId': 'm1', 'delta': 'Hi'}


@pytest.mark.asyncio
async def test_publish_done_includes_finish_reason() -> None:
    nc = _RecordingNats()
    pub = EventPublisher(connection=nc)  # type: ignore[arg-type]
    await pub.done(conversation_id='c1', message_id='m1', finish_reason='stop', tokens_in=10, tokens_out=3)
    payload: dict[str, Any] = json.loads(nc.published[0][1])
    assert payload == {
        'type': 'done', 'messageId': 'm1', 'finishReason': 'stop',
        'tokensIn': 10, 'tokensOut': 3,
    }
```

- [ ] **Step 3 : Lancer, vérifier FAIL**

Run: `cd apps/ai-core && uv run pytest tests/test_events_publisher.py -v`
Expected: FAIL — `EventPublisher` n'existe pas.

- [ ] **Step 4 : Implémenter le publisher**

`apps/ai-core/src/ai_core/events/__init__.py` :
```python
from ai_core.events.publisher import EventPublisher

__all__ = ['EventPublisher']
```

`apps/ai-core/src/ai_core/events/publisher.py` :
```python
"""Publication d'events de cycle d'inférence sur NATS Core."""

from __future__ import annotations

import json
from typing import Literal, Protocol


class _NatsLike(Protocol):
    async def publish(self, subject: str, data: bytes) -> None: ...
    async def drain(self) -> None: ...


class EventPublisher:
    """Émet des events sur le sujet `events.<conversation_id>`.

    NATS Core best-effort : si aucun realtime n'écoute, le message est perdu.
    OK pour Phase 1 (le message assistant final est persisté côté edge-api).
    """

    def __init__(self, connection: _NatsLike) -> None:
        self._conn = connection

    async def token(self, *, conversation_id: str, message_id: str, delta: str) -> None:
        await self._emit(conversation_id, {'type': 'token', 'messageId': message_id, 'delta': delta})

    async def done(
        self,
        *,
        conversation_id: str,
        message_id: str,
        finish_reason: Literal['stop', 'length', 'tool_call', 'error'],
        tokens_in: int,
        tokens_out: int,
    ) -> None:
        await self._emit(conversation_id, {
            'type': 'done',
            'messageId': message_id,
            'finishReason': finish_reason,
            'tokensIn': tokens_in,
            'tokensOut': tokens_out,
        })

    async def error(self, *, conversation_id: str, message_id: str, reason: str) -> None:
        await self._emit(conversation_id, {
            'type': 'error', 'messageId': message_id, 'reason': reason,
        })

    async def _emit(self, conversation_id: str, payload: dict[str, object]) -> None:
        subject = f'events.{conversation_id}'
        await self._conn.publish(subject, json.dumps(payload).encode())
```

- [ ] **Step 5 : Lancer, vérifier PASS**

Run: `cd apps/ai-core && uv run pytest tests/test_events_publisher.py -v`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/ai-core/src/ai_core/events/ apps/ai-core/tests/test_events_publisher.py apps/ai-core/pyproject.toml
git commit -m "feat(ai-core): EventPublisher — publish events.<conversationId> sur NATS"
```

---

### Task 11 : `Orchestrator.turn_stream()` — boucle streaming complète

**Files:**
- Modify: `apps/ai-core/src/ai_core/orchestrator/loop.py`
- Test: `apps/ai-core/tests/test_orchestrator_stream.py`

- [ ] **Step 1 : Écrire le test**

```python
"""Tests Orchestrator.turn_stream — flux InferenceClient → EventPublisher."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from ai_core.inference import ChatMessage, StreamEvent
from ai_core.orchestrator.loop import Orchestrator, TurnInput


class _FakeInference:
    def __init__(self, events: list[StreamEvent]) -> None:
        self._events = events

    async def chat_stream(self, **_: Any) -> AsyncIterator[StreamEvent]:
        for evt in self._events:
            yield evt

    async def aclose(self) -> None: ...


class _FakePublisher:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def token(self, **kw: Any) -> None:
        self.calls.append(('token', kw))

    async def done(self, **kw: Any) -> None:
        self.calls.append(('done', kw))

    async def error(self, **kw: Any) -> None:
        self.calls.append(('error', kw))


@pytest.mark.asyncio
async def test_turn_stream_forwards_tokens_and_done() -> None:
    inference = _FakeInference([
        StreamEvent(type='token', delta='Hi'),
        StreamEvent(type='token', delta='!'),
        StreamEvent(type='done', finish_reason='stop'),
    ])
    pub = _FakePublisher()
    orch = Orchestrator(inference=inference, publisher=pub)  # type: ignore[arg-type]
    await orch.turn_stream(TurnInput(
        workspace_id='w', user_id='u', chat_id='c1', message='hi',
    ), message_id='m1')
    types = [c[0] for c in pub.calls]
    assert types == ['token', 'token', 'done']
    assert pub.calls[0][1]['delta'] == 'Hi'
    assert pub.calls[-1][1]['finish_reason'] == 'stop'


@pytest.mark.asyncio
async def test_turn_stream_emits_error_on_stream_error() -> None:
    inference = _FakeInference([
        StreamEvent(type='error', error='all_backends_failed'),
    ])
    pub = _FakePublisher()
    orch = Orchestrator(inference=inference, publisher=pub)  # type: ignore[arg-type]
    await orch.turn_stream(TurnInput(
        workspace_id='w', user_id='u', chat_id='c1', message='hi',
    ), message_id='m1')
    assert pub.calls[-1][0] == 'error'
    assert pub.calls[-1][1]['reason'] == 'all_backends_failed'
```

- [ ] **Step 2 : Lancer, vérifier FAIL**

Run: `cd apps/ai-core && uv run pytest tests/test_orchestrator_stream.py -v`
Expected: FAIL — `Orchestrator.__init__` n'accepte pas `publisher`.

- [ ] **Step 3 : Implémenter `turn_stream`**

Modifier `apps/ai-core/src/ai_core/orchestrator/loop.py` — étendre `Orchestrator` :

```python
from ai_core.events import EventPublisher


class Orchestrator:
    def __init__(
        self,
        inference: InferenceClient | None = None,
        publisher: EventPublisher | None = None,
    ) -> None:
        self._inference = inference or InferenceClient()
        self._publisher = publisher  # None autorisé pour les tests qui n'utilisent que turn()

    # ... turn() existant inchangé ...

    async def turn_stream(self, input: TurnInput, *, message_id: str) -> None:
        if self._publisher is None:
            raise RuntimeError('turn_stream requires an EventPublisher')

        model = input.model or get_settings().LLM_DEFAULT_MODEL
        logger.info('orchestrator.turn_stream', chat_id=input.chat_id, model=model)

        messages = [
            ChatMessage(role='system', content=_SYSTEM_PROMPT),
            ChatMessage(role='user', content=input.message),
        ]

        tokens_in = sum(len(m.content) for m in messages) // 4  # heuristique simple
        tokens_out = 0
        finish: str = 'stop'
        had_error = False

        async for evt in self._inference.chat_stream(model=model, messages=messages):
            if evt.type == 'token' and evt.delta:
                tokens_out += max(1, len(evt.delta) // 4)
                await self._publisher.token(
                    conversation_id=input.chat_id, message_id=message_id, delta=evt.delta,
                )
            elif evt.type == 'done':
                finish = evt.finish_reason or 'stop'
            elif evt.type == 'error':
                had_error = True
                await self._publisher.error(
                    conversation_id=input.chat_id, message_id=message_id,
                    reason=evt.error or 'unknown',
                )
                return

        if not had_error:
            await self._publisher.done(
                conversation_id=input.chat_id, message_id=message_id,
                finish_reason=finish,  # type: ignore[arg-type]
                tokens_in=tokens_in, tokens_out=tokens_out,
            )
```

- [ ] **Step 4 : Lancer, vérifier PASS**

Run: `cd apps/ai-core && uv run pytest tests/test_orchestrator_stream.py -v`
Expected: PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/ai-core/src/ai_core/orchestrator/loop.py apps/ai-core/tests/test_orchestrator_stream.py
git commit -m "feat(ai-core): Orchestrator.turn_stream — forward StreamEvent vers NATS"
```

---

### Task 12 : Endpoint HTTP `POST /v1/chat/turn/stream`

**Files:**
- Modify: `apps/ai-core/src/ai_core/http.py`
- Modify: `apps/ai-core/src/ai_core/main.ts` (équivalent Python : startup)
- Test: `apps/ai-core/tests/test_http_turn_stream.py`

- [ ] **Step 1 : Écrire le test**

```python
"""Test endpoint POST /v1/chat/turn/stream — 202 + publication NATS asynchrone."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_core.http import create_app


class _StubOrchestrator:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def turn_stream(self, input: Any, *, message_id: str) -> None:
        self.calls.append({'chat_id': input.chat_id, 'message_id': message_id})


@pytest.mark.asyncio
async def test_post_turn_stream_returns_202_immediately() -> None:
    orch = _StubOrchestrator()
    app = create_app(orchestrator=orch)  # type: ignore[arg-type]
    with TestClient(app) as c:
        resp = c.post('/v1/chat/turn/stream', json={
            'conversationId': 'c1', 'workspaceId': 'w', 'userId': 'u',
            'messageId': 'm1', 'model': 'mistral-7b-instruct-q4',
            'history': [{'role': 'user', 'content': 'hello'}],
        })
        assert resp.status_code == 202
    # Laisser le background task tourner.
    await asyncio.sleep(0.05)
    assert orch.calls and orch.calls[0]['message_id'] == 'm1'
```

- [ ] **Step 2 : Lancer, vérifier FAIL**

Run: `cd apps/ai-core && uv run pytest tests/test_http_turn_stream.py -v`
Expected: FAIL — l'endpoint n'existe pas, `create_app` n'accepte pas `orchestrator`.

- [ ] **Step 3 : Implémenter l'endpoint**

Ajouter dans `apps/ai-core/src/ai_core/http.py` :

```python
from fastapi import BackgroundTasks, FastAPI
from pydantic import BaseModel

from ai_core.orchestrator.loop import Orchestrator, TurnInput


class _HistoryMessage(BaseModel):
    role: str
    content: str


class _TurnStreamBody(BaseModel):
    conversationId: str
    workspaceId: str
    userId: str
    messageId: str
    model: str | None = None
    history: list[_HistoryMessage]


def create_app(orchestrator: Orchestrator | None = None) -> FastAPI:
    app = FastAPI(title='ai-core')

    @app.get('/health')
    async def health() -> dict[str, str]:
        return {'status': 'ok'}

    @app.post('/v1/chat/turn/stream', status_code=202)
    async def turn_stream(body: _TurnStreamBody, bg: BackgroundTasks) -> dict[str, str]:
        # Dernier message user = pivot ; en Phase 1 on n'utilise pas l'history
        # complet (passé directement dans messages[]).
        user_msg = next(
            (m.content for m in reversed(body.history) if m.role == 'user'),
            '',
        )
        orch = orchestrator
        if orch is None:
            orch = Orchestrator()  # avec publisher None → erreur ; cas testé avec stub
        bg.add_task(
            orch.turn_stream,
            TurnInput(
                workspace_id=body.workspaceId,
                user_id=body.userId,
                chat_id=body.conversationId,
                message=user_msg,
                model=body.model,
            ),
            message_id=body.messageId,
        )
        return {'status': 'accepted'}

    return app
```

- [ ] **Step 4 : Câbler le `Orchestrator` réel dans `main.py`**

Vérifier que `apps/ai-core/src/ai_core/main.py` (le bootstrap) :
1. Ouvre une connexion NATS (`nats.connect(env.NATS_URL)`).
2. Construit l'`EventPublisher(connection=nc)`.
3. Construit l'`Orchestrator(inference=InferenceClient(), publisher=publisher)`.
4. Passe l'orchestrator à `create_app(orchestrator=...)`.

- [ ] **Step 5 : Lancer le test**

Run: `cd apps/ai-core && uv run pytest tests/test_http_turn_stream.py -v`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/ai-core/src/ai_core/http.py apps/ai-core/src/ai_core/main.py apps/ai-core/tests/test_http_turn_stream.py
git commit -m "feat(ai-core): endpoint POST /v1/chat/turn/stream (202 + background task)"
```

---

## Bloc E — `realtime` : endpoint SSE

### Task 13 : Spec — SSE en plus de WS

**Files:**
- Modify: `docs/specs/realtime/design.md` (créer si absent)

- [ ] **Step 1 : Documenter le contrat SSE**

```markdown
# realtime — Design

## Endpoints

| Endpoint | Usage Phase 1 | Pourquoi |
|---|---|---|
| `GET /sse/v1/conversations/:conversationId/stream?token=<jwt>` | Chat token streaming | Compatible navigateur (EventSource natif), pas besoin de WS pour du download-only. |
| `GET /ws/v1/stream?token=&channel=` | Conservé pour usage futur (voice mode, multi-canal) | Pas démantelé — la couche hub est réutilisée. |

## Format SSE

Chaque event NATS `events.<conversationId>` est relayé tel quel comme `data: <json>\n\n`. Pas de typage SSE (`event:`) pour rester simple ; le client lit le `type` dans le payload JSON.

## Auth

- Le query param `?token=` contient un JWT Keycloak (browser EventSource n'a pas d'headers custom).
- Vérification de signature par `TokenVerifier` (déjà existant).
- ACL : `claims.sub` doit pouvoir lire la conversation. Pour Phase 1, on vérifie juste que le JWT est valide ; la vérification fine (membre du workspace propriétaire de la conv) est ajoutée Task 16 côté edge-api et exposée via un endpoint `GET /internal/conversations/:id/can-read?userId=…` que `realtime` interroge avant d'ouvrir le flux.

## Heartbeat

Toutes les 15 s : `:keepalive\n\n` (ligne de commentaire SSE) pour empêcher les proxies de fermer la connexion.
```

- [ ] **Step 2 : Commit**

```bash
git add docs/specs/realtime/design.md
git commit -m "docs(realtime): spec SSE endpoint conversations + cohabitation WS"
```

---

### Task 14 : Endpoint SSE + relais hub

**Files:**
- Create: `apps/realtime/src/sse/routes.ts`
- Create: `apps/realtime/src/sse/hub.ts`
- Modify: `apps/realtime/src/nats/subscriber.ts` (broadcast vers SSE + WS hubs)
- Modify: `apps/realtime/src/main.ts` (enregistrement)
- Test: `apps/realtime/test/sse.test.ts`

- [ ] **Step 1 : Écrire le test (vitest)**

```typescript
// apps/realtime/test/sse.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SseHub } from '../src/sse/hub';
import { registerSseRoutes } from '../src/sse/routes';

// Faux vérificateur de token qui accepte tout.
const verifier = {
  async verify(_token: string) {
    return { sub: 'user-1' };
  },
};

// Faux ACL : autorise tout.
const acl = { canRead: async () => true };

describe('SSE endpoint', () => {
  let app: FastifyInstance;
  let hub: SseHub;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    hub = new SseHub();
    registerSseRoutes(app, { verifier: verifier as never, hub, acl });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams payloads broadcast through the hub', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/sse/v1/conversations/c1/stream?token=ok`;

    const received: string[] = [];
    const ctrl = new AbortController();
    const respPromise = fetch(url, { signal: ctrl.signal });
    const resp = await respPromise;
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    // Démarrer la lecture en parallèle.
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const readUntil = (async () => {
      while (received.join('').split('\n\n').length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        received.push(decoder.decode(value));
      }
    })();

    // Laisser le temps au handler d'enregistrer le client.
    await new Promise((r) => setTimeout(r, 50));
    hub.broadcast('c1', '{"type":"token","delta":"Hi"}');

    await Promise.race([readUntil, new Promise((r) => setTimeout(r, 500))]);
    ctrl.abort();
    expect(received.join('')).toContain('data: {"type":"token","delta":"Hi"}');
  });
});
```

- [ ] **Step 2 : Lancer, vérifier FAIL**

Run: `cd apps/realtime && pnpm vitest run test/sse.test.ts`
Expected: FAIL — `SseHub` et `registerSseRoutes` n'existent pas.

- [ ] **Step 3 : Implémenter `SseHub`**

`apps/realtime/src/sse/hub.ts` :
```typescript
import type { FastifyReply } from 'fastify';

export interface SseEntry {
  userId: string;
  channel: string;
  reply: FastifyReply;
}

export class SseHub {
  private readonly byChannel = new Map<string, Set<SseEntry>>();

  add(entry: SseEntry): void {
    const set = this.byChannel.get(entry.channel) ?? new Set<SseEntry>();
    set.add(entry);
    this.byChannel.set(entry.channel, set);
  }

  remove(entry: SseEntry): void {
    const set = this.byChannel.get(entry.channel);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) this.byChannel.delete(entry.channel);
  }

  broadcast(channel: string, payload: string): number {
    const set = this.byChannel.get(channel);
    if (!set) return 0;
    let delivered = 0;
    for (const entry of set) {
      entry.reply.raw.write(`data: ${payload}\n\n`);
      delivered++;
    }
    return delivered;
  }

  size(): number {
    let total = 0;
    for (const s of this.byChannel.values()) total += s.size;
    return total;
  }
}
```

- [ ] **Step 4 : Implémenter `registerSseRoutes`**

`apps/realtime/src/sse/routes.ts` :
```typescript
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TokenVerifier } from '../auth';
import type { SseHub, SseEntry } from './hub';

export interface ConversationAcl {
  canRead(userId: string, conversationId: string): Promise<boolean>;
}

export function registerSseRoutes(
  app: FastifyInstance,
  deps: { verifier: TokenVerifier; hub: SseHub; acl: ConversationAcl },
): void {
  app.get<{
    Params: { conversationId: string };
    Querystring: { token?: string };
  }>('/sse/v1/conversations/:conversationId/stream', async (req, reply) => {
    const token = req.query.token;
    if (!token) {
      reply.code(401).send({ error: 'missing token' });
      return;
    }
    let claims: { sub: string };
    try {
      claims = await deps.verifier.verify(token);
    } catch {
      reply.code(401).send({ error: 'invalid token' });
      return;
    }
    if (!(await deps.acl.canRead(claims.sub, req.params.conversationId))) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const entry: SseEntry = {
      userId: claims.sub,
      channel: req.params.conversationId,
      reply,
    };
    deps.hub.add(entry);

    const heartbeat = setInterval(() => {
      reply.raw.write(':keepalive\n\n');
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      deps.hub.remove(entry);
    });
  });
}
```

- [ ] **Step 5 : Brancher le subscriber sur les deux hubs**

Modifier `apps/realtime/src/nats/subscriber.ts` — accepter un tableau de hubs au lieu d'un seul :
```typescript
export interface Broadcastable {
  broadcast(channel: string, payload: string): number;
}

export class NatsSubscriber {
  constructor(
    private readonly url: string,
    private readonly hubs: readonly Broadcastable[],
    private readonly log: (msg: string, extra?: object) => void,
  ) {}
  // ... start() inchangé sauf que `this.hub.broadcast(...)` devient :
  //     for (const h of this.hubs) h.broadcast(channel, payload);
}
```

Adapter `apps/realtime/src/main.ts` :
```typescript
const wsHub = new ConnectionHub();
const sseHub = new SseHub();
// ... registerWsRoutes(app, { verifier, hub: wsHub });
// ... registerSseRoutes(app, { verifier, hub: sseHub, acl: realAclClient });
const subscriber = new NatsSubscriber(env.NATS_URL, [wsHub, sseHub], log);
```

L'ACL `realAclClient` appelle `GET ${EDGE_API_INTERNAL_URL}/internal/conversations/:id/can-read?userId=…`. Pour Phase 1, on peut commencer par une implémentation stub qui retourne `true` si un JWT valide est fourni (TODO ajouté en commentaire) — Task 17 ajoutera l'ACL réelle.

- [ ] **Step 6 : Lancer le test, vérifier PASS**

Run: `cd apps/realtime && pnpm vitest run test/sse.test.ts`
Expected: PASS.

- [ ] **Step 7 : Commit**

```bash
git add apps/realtime/src/ apps/realtime/test/sse.test.ts
git commit -m "feat(realtime): endpoint SSE conversations + relais NATS multi-hub"
```

---

## Bloc F — `edge-api` : module `conversations`

### Task 15 : Module conversations (entities + repository + GraphQL types)

**Files:**
- Create: `apps/edge-api/src/modules/conversations/conversations.module.ts`
- Create: `apps/edge-api/src/modules/conversations/conversations.repository.ts`
- Create: `apps/edge-api/src/modules/conversations/messages.repository.ts`
- Create: `apps/edge-api/src/modules/conversations/models/conversation.model.ts`
- Create: `apps/edge-api/src/modules/conversations/models/message.model.ts`
- Test: `apps/edge-api/src/modules/conversations/conversations.repository.spec.ts`

- [ ] **Step 1 : Modèles GraphQL**

`conversation.model.ts` :
```typescript
import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Conversation {
  @Field(() => ID)
  id!: string;
  @Field(() => ID)
  workspaceId!: string;
  @Field({ nullable: true })
  title?: string;
  @Field({ nullable: true })
  model?: string;
  @Field()
  createdAt!: Date;
  @Field()
  updatedAt!: Date;
}
```

`message.model.ts` :
```typescript
import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum MessageRole { USER = 'user', ASSISTANT = 'assistant', SYSTEM = 'system', TOOL = 'tool' }
registerEnumType(MessageRole, { name: 'MessageRole' });

@ObjectType()
export class Message {
  @Field(() => ID)
  id!: string;
  @Field(() => ID)
  conversationId!: string;
  @Field(() => MessageRole)
  role!: MessageRole;
  @Field()
  content!: string;
  @Field({ nullable: true })
  finishReason?: string;
  @Field()
  createdAt!: Date;
}
```

- [ ] **Step 2 : Repository des conversations**

`conversations.repository.ts` :
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CONNECTION, type SqlConn } from '../../database/database.service';

export interface ConversationRow {
  id: string;
  workspace_id: string;
  created_by: string;
  title: string | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly sql: SqlConn) {}

  async create(input: { workspaceId: string; createdBy: string; model?: string; title?: string }): Promise<ConversationRow> {
    const rows = await this.sql<ConversationRow[]>`
      INSERT INTO conversations.conversations (workspace_id, created_by, model, title)
      VALUES (${input.workspaceId}, ${input.createdBy}, ${input.model ?? null}, ${input.title ?? null})
      RETURNING *
    `;
    return rows[0];
  }

  async findById(id: string): Promise<ConversationRow | null> {
    const rows = await this.sql<ConversationRow[]>`
      SELECT * FROM conversations.conversations WHERE id = ${id} AND deleted_at IS NULL
    `;
    return rows[0] ?? null;
  }

  async listByWorkspace(workspaceId: string, limit = 50): Promise<ConversationRow[]> {
    return this.sql<ConversationRow[]>`
      SELECT * FROM conversations.conversations
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT ${limit}
    `;
  }

  async touchUpdatedAt(id: string): Promise<void> {
    await this.sql`UPDATE conversations.conversations SET updated_at = now() WHERE id = ${id}`;
  }
}
```

- [ ] **Step 3 : Repository des messages**

`messages.repository.ts` :
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE_CONNECTION, type SqlConn } from '../../database/database.service';

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  finish_reason: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: Date;
}

@Injectable()
export class MessagesRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly sql: SqlConn) {}

  async append(input: {
    conversationId: string;
    role: MessageRow['role'];
    content: string;
  }): Promise<MessageRow> {
    const rows = await this.sql<MessageRow[]>`
      INSERT INTO conversations.messages (conversation_id, role, content)
      VALUES (${input.conversationId}, ${input.role}, ${input.content})
      RETURNING *
    `;
    return rows[0];
  }

  async updateAssistantFinal(id: string, content: string, finishReason: string, tokensIn: number, tokensOut: number): Promise<void> {
    await this.sql`
      UPDATE conversations.messages
      SET content = ${content}, finish_reason = ${finishReason},
          tokens_in = ${tokensIn}, tokens_out = ${tokensOut}
      WHERE id = ${id}
    `;
  }

  async listByConversation(conversationId: string, limit = 200): Promise<MessageRow[]> {
    return this.sql<MessageRow[]>`
      SELECT * FROM conversations.messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC LIMIT ${limit}
    `;
  }
}
```

- [ ] **Step 4 : Module**

`conversations.module.ts` :
```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsResolver } from './conversations.resolver';
import { ConversationsService } from './conversations.service';
import { MessagesRepository } from './messages.repository';

@Module({
  imports: [AuthModule],
  providers: [
    ConversationsRepository,
    MessagesRepository,
    ConversationsService,
    ConversationsResolver,
  ],
  exports: [ConversationsService],
})
export class ConversationsModule {}
```
(Le resolver et le service sont créés Task 16 mais déclarés ici pour pouvoir wirer le module dans `AppModule` dès maintenant.)

- [ ] **Step 5 : Test repo**

`conversations.repository.spec.ts` :
```typescript
import { ConversationsRepository } from './conversations.repository';

describe('ConversationsRepository', () => {
  it('inserts and returns the row via sql tag', async () => {
    const sqlMock = jest.fn().mockResolvedValueOnce([{
      id: 'c1', workspace_id: 'w', created_by: 'u',
      title: null, model: null, created_at: new Date(), updated_at: new Date(),
    }]);
    const repo = new ConversationsRepository(sqlMock as never);
    const row = await repo.create({ workspaceId: 'w', createdBy: 'u' });
    expect(row.id).toBe('c1');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
```

Run: `cd apps/edge-api && pnpm jest conversations.repository.spec`
Expected: PASS (le mock cible la fonction template tag).

- [ ] **Step 6 : Wirer le module**

Dans `apps/edge-api/src/app.module.ts`, ajouter `ConversationsModule` à `imports`.

- [ ] **Step 7 : Commit**

```bash
git add apps/edge-api/src/modules/conversations/ apps/edge-api/src/app.module.ts
git commit -m "feat(edge-api): module conversations — entities + repositories"
```

---

### Task 16 : Service + mutation `sendMessage` (HTTP vers ai-core)

**Files:**
- Create: `apps/edge-api/src/modules/conversations/conversations.service.ts`
- Create: `apps/edge-api/src/modules/conversations/conversations.resolver.ts`
- Create: `apps/edge-api/src/modules/conversations/ai-core.client.ts`
- Test: `apps/edge-api/src/modules/conversations/conversations.service.spec.ts`

- [ ] **Step 1 : Client HTTP vers ai-core**

`ai-core.client.ts` :
```typescript
import { Injectable } from '@nestjs/common';

export interface AiCoreTurnStreamRequest {
  conversationId: string;
  workspaceId: string;
  userId: string;
  messageId: string;
  model?: string;
  history: { role: string; content: string }[];
}

@Injectable()
export class AiCoreClient {
  private readonly baseUrl: string;
  constructor() {
    this.baseUrl = (process.env.AI_CORE_URL ?? 'http://ai-core:5001').replace(/\/$/, '');
  }

  async triggerTurnStream(req: AiCoreTurnStreamRequest): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/turn/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (resp.status !== 202) {
      throw new Error(`ai-core returned ${resp.status}`);
    }
  }
}
```

- [ ] **Step 2 : Service**

`conversations.service.ts` :
```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { AiCoreClient } from './ai-core.client';
import { ConversationsRepository } from './conversations.repository';
import { MessagesRepository } from './messages.repository';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly convRepo: ConversationsRepository,
    private readonly msgRepo: MessagesRepository,
    private readonly aiCore: AiCoreClient,
  ) {}

  async startConversation(input: { workspaceId: string; userId: string; model?: string }): Promise<string> {
    const row = await this.convRepo.create({
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      model: input.model,
    });
    return row.id;
  }

  async sendMessage(input: {
    conversationId: string;
    userId: string;
    content: string;
  }): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const conv = await this.convRepo.findById(input.conversationId);
    if (!conv) throw new NotFoundException('conversation not found');

    const userMsg = await this.msgRepo.append({
      conversationId: conv.id,
      role: 'user',
      content: input.content,
    });
    const assistantMsg = await this.msgRepo.append({
      conversationId: conv.id,
      role: 'assistant',
      content: '',
    });
    await this.convRepo.touchUpdatedAt(conv.id);

    const history = await this.msgRepo.listByConversation(conv.id);
    const historyForAi = history
      .filter((m) => m.id !== assistantMsg.id) // ne pas inclure le placeholder vide
      .map((m) => ({ role: m.role, content: m.content }));

    // Fire-and-forget : si ai-core est down, l'erreur est loggée mais la
    // mutation a déjà persisté le message user. Le client verra le message
    // assistant rester vide ; un retry manuel/automatique sera ajouté Phase 2.
    void this.aiCore
      .triggerTurnStream({
        conversationId: conv.id,
        workspaceId: conv.workspace_id,
        userId: input.userId,
        messageId: assistantMsg.id,
        model: conv.model ?? undefined,
        history: historyForAi,
      })
      .catch((err) => {
        console.error('ai-core triggerTurnStream failed', err);
      });

    return { userMessageId: userMsg.id, assistantMessageId: assistantMsg.id };
  }
}
```

- [ ] **Step 3 : Resolver**

`conversations.resolver.ts` :
```typescript
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, ObjectType, Field, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AccessTokenClaims } from '../auth/jwt.service';
import { ConversationsService } from './conversations.service';

@ObjectType()
class SendMessageResult {
  @Field(() => ID)
  conversationId!: string;
  @Field(() => ID)
  userMessageId!: string;
  @Field(() => ID)
  assistantMessageId!: string;
}

@Resolver()
export class ConversationsResolver {
  constructor(private readonly svc: ConversationsService) {}

  @Mutation(() => ID)
  @UseGuards(JwtAuthGuard)
  async startConversation(
    @CurrentUser() claims: AccessTokenClaims,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('model', { nullable: true }) model?: string,
  ): Promise<string> {
    return this.svc.startConversation({ workspaceId, userId: claims.sub, model });
  }

  @Mutation(() => SendMessageResult)
  @UseGuards(JwtAuthGuard)
  async sendMessage(
    @CurrentUser() claims: AccessTokenClaims,
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('content') content: string,
  ): Promise<SendMessageResult> {
    const out = await this.svc.sendMessage({
      conversationId, userId: claims.sub, content,
    });
    return { conversationId, ...out };
  }
}
```

- [ ] **Step 4 : Test du service**

`conversations.service.spec.ts` :
```typescript
import { ConversationsService } from './conversations.service';

describe('ConversationsService.sendMessage', () => {
  it('persists user + assistant placeholder then calls ai-core', async () => {
    const convRepo = {
      findById: jest.fn().mockResolvedValue({ id: 'c1', workspace_id: 'w', model: null }),
      touchUpdatedAt: jest.fn().mockResolvedValue(undefined),
    };
    const msgRepo = {
      append: jest.fn()
        .mockResolvedValueOnce({ id: 'mu' })
        .mockResolvedValueOnce({ id: 'ma' }),
      listByConversation: jest.fn().mockResolvedValue([
        { id: 'mu', role: 'user', content: 'hi' },
        { id: 'ma', role: 'assistant', content: '' },
      ]),
    };
    const aiCore = { triggerTurnStream: jest.fn().mockResolvedValue(undefined) };
    const svc = new ConversationsService(convRepo as never, msgRepo as never, aiCore as never);

    const out = await svc.sendMessage({ conversationId: 'c1', userId: 'u', content: 'hi' });
    expect(out).toEqual({ userMessageId: 'mu', assistantMessageId: 'ma' });
    expect(msgRepo.append).toHaveBeenCalledTimes(2);
    // Laisser le microtask `void` se résoudre.
    await new Promise((r) => setImmediate(r));
    expect(aiCore.triggerTurnStream).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'c1', messageId: 'ma',
      history: [{ role: 'user', content: 'hi' }],
    }));
  });
});
```

Run: `cd apps/edge-api && pnpm jest conversations.service.spec`
Expected: PASS.

- [ ] **Step 5 : Ajouter `AiCoreClient` au module**

Dans `conversations.module.ts`, ajouter `AiCoreClient` à `providers`.

- [ ] **Step 6 : Commit**

```bash
git add apps/edge-api/src/modules/conversations/
git commit -m "feat(edge-api): mutation sendMessage + appel HTTP fire-and-forget vers ai-core"
```

---

### Task 17 : ACL inter-services + endpoint `can-read`

**Files:**
- Modify: `apps/edge-api/src/modules/conversations/conversations.module.ts`
- Create: `apps/edge-api/src/modules/conversations/conversations-internal.controller.ts`
- Modify: `apps/realtime/src/sse/routes.ts` (déjà créé Task 14) — câbler ACL réelle
- Test: `apps/edge-api/src/modules/conversations/conversations-internal.controller.spec.ts`

**Pourquoi :** Avant que `realtime` ouvre le flux SSE pour un client, il doit vérifier que l'utilisateur peut lire la conversation. La source de vérité est edge-api (qui possède les schémas auth + conversations).

- [ ] **Step 1 : Écrire le test du controller**

```typescript
// conversations-internal.controller.spec.ts
import { ConversationsInternalController } from './conversations-internal.controller';

describe('ConversationsInternalController.canRead', () => {
  it('returns canRead=true when user is member of the conversation workspace', async () => {
    const convRepo = { findById: jest.fn().mockResolvedValue({ id: 'c1', workspace_id: 'w' }) };
    const memberRepo = { isMember: jest.fn().mockResolvedValue(true) };
    const ctrl = new ConversationsInternalController(convRepo as never, memberRepo as never);
    expect(await ctrl.canRead('c1', 'u1')).toEqual({ canRead: true });
    expect(memberRepo.isMember).toHaveBeenCalledWith('w', 'u1');
  });

  it('returns canRead=false when conversation missing', async () => {
    const convRepo = { findById: jest.fn().mockResolvedValue(null) };
    const memberRepo = { isMember: jest.fn() };
    const ctrl = new ConversationsInternalController(convRepo as never, memberRepo as never);
    expect(await ctrl.canRead('c1', 'u1')).toEqual({ canRead: false });
  });
});
```

- [ ] **Step 2 : Implémenter le controller**

```typescript
// conversations-internal.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ConversationsRepository } from './conversations.repository';
// `WorkspaceMembersRepository` doit déjà exister côté module auth ;
// si pas le cas, créer un helper minimal qui fait :
//   SELECT 1 FROM auth.workspace_members WHERE workspace_id=$1 AND user_id=$2

export interface WorkspaceMembersLike {
  isMember(workspaceId: string, userId: string): Promise<boolean>;
}

@Controller('internal/conversations')
export class ConversationsInternalController {
  constructor(
    private readonly conv: ConversationsRepository,
    private readonly members: WorkspaceMembersLike,
  ) {}

  @Get(':id/can-read')
  async canRead(
    @Param('id') id: string,
    @Query('userId') userId: string,
  ): Promise<{ canRead: boolean }> {
    const c = await this.conv.findById(id);
    if (!c) return { canRead: false };
    const ok = await this.members.isMember(c.workspace_id, userId);
    return { canRead: ok };
  }
}
```

- [ ] **Step 3 : Sécuriser l'endpoint interne**

Cet endpoint ne doit pas être exposé publiquement. Il doit être accessible uniquement sur le réseau interne. Deux options :
- (a) Header partagé `X-Internal-Secret` vérifié par un Guard.
- (b) Route bindée sur un port différent (séparation network).

Pour Phase 1, on choisit (a) — créer `apps/edge-api/src/modules/conversations/internal-auth.guard.ts` qui vérifie `req.headers['x-internal-secret'] === process.env.INTERNAL_SHARED_SECRET`. Appliquer `@UseGuards(InternalAuthGuard)` sur le controller.

- [ ] **Step 4 : Côté realtime, appeler can-read**

Dans `apps/realtime/src/sse/routes.ts`, remplacer le stub d'ACL par un client réel :
```typescript
export class HttpConversationAcl implements ConversationAcl {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}
  async canRead(userId: string, conversationId: string): Promise<boolean> {
    const resp = await fetch(
      `${this.baseUrl}/internal/conversations/${encodeURIComponent(conversationId)}/can-read?userId=${encodeURIComponent(userId)}`,
      { headers: { 'x-internal-secret': this.secret } },
    );
    if (!resp.ok) return false;
    const body = await resp.json() as { canRead: boolean };
    return body.canRead === true;
  }
}
```
Ajouter `EDGE_API_INTERNAL_URL` et `INTERNAL_SHARED_SECRET` au schéma d'env de realtime (`apps/realtime/src/config/env.ts`).

- [ ] **Step 5 : Lancer tous les tests des modules touchés**

Run: `cd apps/edge-api && pnpm jest conversations` then `cd apps/realtime && pnpm vitest run`
Expected: tous PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/edge-api/src/modules/conversations/ apps/realtime/src/
git commit -m "feat(edge-api,realtime): endpoint can-read + ACL HTTP cross-service"
```

---

## Bloc G — `apps/web` : frontend Next.js minimal

### Task 18 : Bootstrap Next.js 15 (app router + GraphQL codegen)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/codegen.ts`
- Modify: `pnpm-workspace.yaml` (ajouter `apps/web`)

- [ ] **Step 1 : Vérifier qu'`apps/web` n'existe pas déjà**

Run: `ls apps/ | grep web`
Si présent et non-vide, lire la structure existante avant de la modifier.

- [ ] **Step 2 : Initialiser le projet**

Run (depuis la racine du repo) :
```bash
pnpm create next-app apps/web --typescript --eslint --app --src-dir --import-alias '@/*' --tailwind=false --use-pnpm --no-experimental-app
```
Si la commande interactive ne fonctionne pas, créer manuellement les fichiers minimum :

`apps/web/package.json` :
```json
{
  "name": "@claudemaison/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "codegen": "graphql-codegen --config codegen.ts"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "graphql": "^16.9.0",
    "graphql-request": "^7.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@graphql-codegen/cli": "^5.0.0",
    "@graphql-codegen/typescript": "^4.1.0",
    "@graphql-codegen/typescript-operations": "^4.3.0",
    "@graphql-codegen/typescript-graphql-request": "^6.2.0"
  }
}
```

`apps/web/tsconfig.json` : standard Next.js 15 (copier le template officiel).

`apps/web/codegen.ts` :
```typescript
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'http://localhost:5000/graphql',
  documents: ['src/**/*.graphql'],
  generates: {
    './src/gql/generated.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-graphql-request'],
    },
  },
};
export default config;
```

- [ ] **Step 3 : Ajouter au workspace pnpm**

Modifier `pnpm-workspace.yaml` — ajouter `apps/web` à la liste si pas déjà présent.

Run: `pnpm install`
Expected: succès, `apps/web/node_modules` créé.

- [ ] **Step 4 : Page d'accueil minimale**

`apps/web/src/app/page.tsx` :
```typescript
export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>ClaudeMaison</h1>
      <p>Walking skeleton — Phase 1.</p>
      <a href="/chat/new">Démarrer une conversation</a>
    </main>
  );
}
```

- [ ] **Step 5 : Lancer le dev server pour smoke**

Run: `cd apps/web && pnpm dev`
Aller sur `http://localhost:3000`, vérifier que la page s'affiche.

- [ ] **Step 6 : Commit**

```bash
git add apps/web/ pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(web): bootstrap Next.js 15 app router + codegen GraphQL"
```

---

### Task 19 : Auth OIDC (Keycloak) côté web

**Files:**
- Create: `apps/web/src/lib/auth.ts`
- Create: `apps/web/src/app/api/auth/[...nextauth]/route.ts`
- Modify: `apps/web/package.json` (ajouter next-auth)

- [ ] **Step 1 : Ajouter `next-auth` v5**

Dans `apps/web/package.json` dependencies : `"next-auth": "^5.0.0-beta.20"`.
Run: `pnpm install`.

- [ ] **Step 2 : Configurer NextAuth avec le provider Keycloak**

`apps/web/src/lib/auth.ts` :
```typescript
import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
      issuer: process.env.KEYCLOAK_ISSUER!,
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account?.access_token) token.accessToken = account.access_token;
      return token;
    },
    async session({ session, token }) {
      (session as never as { accessToken?: string }).accessToken = token.accessToken as string;
      return session;
    },
  },
});
```

`apps/web/src/app/api/auth/[...nextauth]/route.ts` :
```typescript
export { handlers as GET, handlers as POST } from '@/lib/auth';
```

- [ ] **Step 3 : Variables d'env nécessaires**

Ajouter à `apps/web/.env.local` (non commité ; documenter dans `.env.example`) :
```
KEYCLOAK_ISSUER=http://localhost:8080/realms/claudemaison
KEYCLOAK_CLIENT_ID=claudemaison-web
KEYCLOAK_CLIENT_SECRET=<from-keycloak>
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<openssl rand -hex 32>
```

- [ ] **Step 4 : Smoke manuel**

Démarrer keycloak (`make compose-up PROFILES=oidc`), créer le client `claudemaison-web` si pas déjà fait, démarrer `pnpm dev`. Aller sur `/api/auth/signin/keycloak` → vérifier la redirection vers Keycloak puis le retour authentifié.

- [ ] **Step 5 : Commit**

```bash
git add apps/web/src/lib/auth.ts apps/web/src/app/api/auth/ apps/web/package.json apps/web/.env.example
git commit -m "feat(web): auth NextAuth v5 + provider Keycloak"
```

---

### Task 20 : Page `/chat/[id]` avec streaming SSE

**Files:**
- Create: `apps/web/src/app/chat/new/page.tsx`
- Create: `apps/web/src/app/chat/[id]/page.tsx`
- Create: `apps/web/src/components/ChatStream.tsx`
- Create: `apps/web/src/lib/gql.ts`
- Create: `apps/web/src/lib/graphql/sendMessage.graphql`
- Create: `apps/web/src/lib/graphql/startConversation.graphql`

- [ ] **Step 1 : Documents GraphQL**

`startConversation.graphql` :
```graphql
mutation StartConversation($workspaceId: ID!, $model: String) {
  startConversation(workspaceId: $workspaceId, model: $model)
}
```

`sendMessage.graphql` :
```graphql
mutation SendMessage($conversationId: ID!, $content: String!) {
  sendMessage(conversationId: $conversationId, content: $content) {
    conversationId
    userMessageId
    assistantMessageId
  }
}
```

- [ ] **Step 2 : Client GraphQL**

`apps/web/src/lib/gql.ts` :
```typescript
import { GraphQLClient } from 'graphql-request';

export function gqlClient(accessToken: string): GraphQLClient {
  const url = process.env.NEXT_PUBLIC_GRAPHQL_URL ?? 'http://localhost:5000/graphql';
  return new GraphQLClient(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}
```

- [ ] **Step 3 : Page `/chat/new` → crée une conv puis redirige**

`apps/web/src/app/chat/new/page.tsx` :
```typescript
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ChatNew() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const resp = await fetch('/api/chat/start', { method: 'POST' });
      const { conversationId } = await resp.json();
      router.replace(`/chat/${conversationId}`);
    })();
  }, [router]);
  return <main>Création de la conversation…</main>;
}
```

Et un route handler `apps/web/src/app/api/chat/start/route.ts` qui fait l'appel GraphQL côté serveur (parce que le token Keycloak est dans la session NextAuth, pas dans le navigateur) :
```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

export async function POST() {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  // Workspace par défaut : le premier du user (à raffiner Phase 2).
  const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID!;
  const data = await gqlClient(accessToken).request<{ startConversation: string }>(`
    mutation { startConversation(workspaceId: "${workspaceId}") }
  `);
  return NextResponse.json({ conversationId: data.startConversation });
}
```

- [ ] **Step 4 : Composant ChatStream avec EventSource**

`apps/web/src/components/ChatStream.tsx` :
```typescript
'use client';
import { useEffect, useRef, useState } from 'react';

export interface ChatStreamProps {
  conversationId: string;
  /** JWT exposé via /api/chat/sse-token (route handler qui retourne accessToken) */
  ssetokenUrl: string;
}

export function ChatStream({ conversationId, ssetokenUrl }: ChatStreamProps) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const currentAssistantRef = useRef<{ index: number; id?: string } | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    (async () => {
      const tokenResp = await fetch(ssetokenUrl);
      const { token } = await tokenResp.json();
      const url = `${process.env.NEXT_PUBLIC_REALTIME_URL}/sse/v1/conversations/${conversationId}/stream?token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.onmessage = (evt) => {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'token') {
          setMessages((prev) => {
            const next = [...prev];
            const cur = currentAssistantRef.current;
            if (cur && next[cur.index]) {
              next[cur.index] = { ...next[cur.index], content: next[cur.index].content + payload.delta };
            } else {
              currentAssistantRef.current = { index: next.length, id: payload.messageId };
              next.push({ role: 'assistant', content: payload.delta });
            }
            return next;
          });
        } else if (payload.type === 'done' || payload.type === 'error') {
          currentAssistantRef.current = null;
        }
      };
    })();
    return () => { es?.close(); };
  }, [conversationId, ssetokenUrl]);

  async function send() {
    if (!input.trim()) return;
    const userMessage = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, content: userMessage }),
    });
  }

  return (
    <div>
      <ul>
        {messages.map((m, i) => (
          <li key={i}><strong>{m.role}:</strong> {m.content}</li>
        ))}
      </ul>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
      <button onClick={send}>Envoyer</button>
    </div>
  );
}
```

Et les route handlers compagnons :

`apps/web/src/app/api/chat/sse-token/route.ts` :
```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export async function GET() {
  const session = await auth();
  const token = (session as never as { accessToken?: string })?.accessToken;
  if (!token) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  return NextResponse.json({ token });
}
```

`apps/web/src/app/api/chat/send/route.ts` :
```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { gqlClient } from '@/lib/gql';

export async function POST(req: Request) {
  const session = await auth();
  const accessToken = (session as never as { accessToken?: string })?.accessToken;
  if (!accessToken) return NextResponse.json({ error: 'unauth' }, { status: 401 });
  const { conversationId, content } = await req.json();
  const data = await gqlClient(accessToken).request(`
    mutation { sendMessage(conversationId: "${conversationId}", content: ${JSON.stringify(content)}) {
      conversationId userMessageId assistantMessageId
    }}
  `);
  return NextResponse.json(data);
}
```

- [ ] **Step 5 : Page `/chat/[id]`**

`apps/web/src/app/chat/[id]/page.tsx` :
```typescript
import { ChatStream } from '@/components/ChatStream';

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatStream conversationId={id} ssetokenUrl="/api/chat/sse-token" />;
}
```

- [ ] **Step 6 : Smoke**

Démarrer toute la stack (`make compose-up PROFILES=oidc,ai,apps,obs`), `pnpm dev` sur web. Se connecter via Keycloak, aller sur `/chat/new`, taper "salut", observer les tokens apparaître. Si la stack llama.cpp n'est pas prête (cf. Task 21), forcer le modèle Mistral via `NEXT_PUBLIC_DEFAULT_MODEL=mistral-large-latest`.

- [ ] **Step 7 : Commit**

```bash
git add apps/web/src/
git commit -m "feat(web): page /chat/[id] + composant ChatStream (EventSource SSE)"
```

---

## Bloc H — Compose & smoke E2E

### Task 21 : Ajouter `llama-cpp-server` au docker-compose

**Files:**
- Modify: `infrastructure/docker/docker-compose.dev.yml`
- Modify: `infrastructure/docker/.env.dev.example`

**Pourquoi :** sans backend d'inférence local, le walking skeleton ne peut tourner qu'en mode Mistral fallback. On ajoute un service llama-cpp accessible depuis `inference-router` sur le réseau interne. Le service est gardé derrière un profil `gpu` pour ne pas l'imposer aux contributeurs sans GPU.

- [ ] **Step 1 : Ajouter le service au compose**

Insérer dans `infrastructure/docker/docker-compose.dev.yml`, à côté des services existants du profil `ai` :

```yaml
  llama-cpp:
    image: ghcr.io/ggerganov/llama.cpp:server-rocm  # tag ROCm officiel
    profiles: ['gpu']
    devices:
      - /dev/kfd
      - /dev/dri
    group_add: ['video']
    environment:
      LLAMA_ARG_MODEL: /models/mistral-7b-instruct-v0.3.Q4_K_M.gguf
      LLAMA_ARG_HOST: 0.0.0.0
      LLAMA_ARG_PORT: '8080'
      LLAMA_ARG_N_GPU_LAYERS: '999'
      LLAMA_ARG_CTX_SIZE: '4096'
    volumes:
      - llama-models:/models:ro
    networks: [internal]
    ports:
      - '8080:8080'  # exposé côté host pour debug ; à retirer en prod
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8080/health']
      interval: 10s
      timeout: 3s
      retries: 10

volumes:
  llama-models:
```

Et adapter le service `inference-router` (s'il existe déjà dans le compose) pour que sa variable `MODEL_BACKENDS` pointe vers `http://llama-cpp:8080` en primaire et `mistral:https://api.mistral.ai|env:MISTRAL_API_KEY` en fallback :

```yaml
  inference-router:
    # ... build existant ...
    profiles: ['ai']
    environment:
      MODEL_BACKENDS: 'mistral-7b-instruct-q4=http://llama-cpp:8080|prio:0,mistral:https://api.mistral.ai|prio:1|env:MISTRAL_API_KEY'
      MISTRAL_API_KEY: ${MISTRAL_API_KEY:-}
```

- [ ] **Step 2 : Documenter `MISTRAL_API_KEY` dans `.env.dev.example`**

Ajouter :
```
# Compte Mistral (souverain EU) — utilisé comme fallback par inference-router.
MISTRAL_API_KEY=
```

- [ ] **Step 3 : Téléchargement initial du modèle GGUF**

Documenter dans `apps/inference-router/README.md` (créer la section "Démarrage local") :
```bash
# Une seule fois, après le `make compose-up PROFILES=gpu`
docker compose -f infrastructure/docker/docker-compose.dev.yml exec llama-cpp \
  curl -L -o /models/mistral-7b-instruct-v0.3.Q4_K_M.gguf \
  https://huggingface.co/MaziyarPanahi/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q4_K_M.gguf
```

- [ ] **Step 4 : Smoke local**

Run: `make compose-up PROFILES=ai,gpu`
Attendre que `llama-cpp` soit healthy, puis :
```bash
curl http://localhost:8080/health
curl -X POST http://localhost:4200/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mistral-7b-instruct-q4","messages":[{"role":"user","content":"hi"}],"stream":false}'
```
Expected: réponse JSON avec un `choices[0].message.content` non vide.

- [ ] **Step 5 : Commit**

```bash
git add infrastructure/docker/docker-compose.dev.yml infrastructure/docker/.env.dev.example apps/inference-router/README.md
git commit -m "feat(compose): service llama-cpp (profil gpu) + routing primary→fallback"
```

---

### Task 22 : Smoke E2E — script `make smoke-chat`

**Files:**
- Create: `infrastructure/scripts/smoke-chat.sh`
- Modify: `Makefile` (ajouter la cible `smoke-chat`)
- Test: lancement manuel

- [ ] **Step 1 : Écrire le script**

`infrastructure/scripts/smoke-chat.sh` :
```bash
#!/usr/bin/env bash
# Smoke E2E Phase 1 : démarre la stack puis vérifie que le chemin complet
# (edge-api → ai-core → inference-router → llama.cpp/Mistral → NATS → realtime)
# délivre au moins un token SSE en moins de 30 s.
#
# Pré-requis :
#   - stack démarrée (make compose-up PROFILES=oidc,ai,apps,gpu)
#   - utilisateur de test seeded dans Keycloak (DEMO_USER / DEMO_PASS)
#   - workspace de test créé (DEMO_WORKSPACE_ID)
set -euo pipefail

GRAPHQL_URL="${GRAPHQL_URL:-http://localhost:5000/graphql}"
REALTIME_URL="${REALTIME_URL:-http://localhost:5500}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"

echo '→ obtention token Keycloak'
ACCESS_TOKEN=$(curl -s -X POST \
  "$KEYCLOAK_URL/realms/claudemaison/protocol/openid-connect/token" \
  -d "client_id=claudemaison-web" \
  -d "client_secret=$KEYCLOAK_CLIENT_SECRET" \
  -d "grant_type=password" \
  -d "username=$DEMO_USER" \
  -d "password=$DEMO_PASS" | jq -r .access_token)
test -n "$ACCESS_TOKEN" && test "$ACCESS_TOKEN" != "null" || { echo 'token KO'; exit 1; }

echo '→ création de conversation'
CONV_ID=$(curl -s -X POST "$GRAPHQL_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"mutation { startConversation(workspaceId: \\\"$DEMO_WORKSPACE_ID\\\") }\"}" \
  | jq -r '.data.startConversation')
test -n "$CONV_ID" || { echo 'conv KO'; exit 1; }
echo "conv = $CONV_ID"

echo '→ ouverture SSE en arrière-plan'
SSE_OUT=$(mktemp)
( timeout 30 curl -sN \
    "$REALTIME_URL/sse/v1/conversations/$CONV_ID/stream?token=$ACCESS_TOKEN" \
    > "$SSE_OUT" || true ) &
SSE_PID=$!
sleep 1

echo '→ envoi du message'
curl -s -X POST "$GRAPHQL_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"mutation { sendMessage(conversationId: \\\"$CONV_ID\\\", content: \\\"Bonjour\\\") { assistantMessageId } }\"}" \
  | jq .

echo '→ attente premier token (max 30 s)'
wait "$SSE_PID" || true

if grep -q '"type":"token"' "$SSE_OUT"; then
  echo 'OK — token reçu via SSE'
  head -5 "$SSE_OUT"
  rm -f "$SSE_OUT"
  exit 0
fi

echo 'KO — aucun token reçu'
echo '--- dump SSE ---'
cat "$SSE_OUT"
rm -f "$SSE_OUT"
exit 1
```

- [ ] **Step 2 : Cible Makefile**

Ajouter à `Makefile` (à la racine) :
```makefile
.PHONY: smoke-chat
smoke-chat:
	@bash infrastructure/scripts/smoke-chat.sh
```

- [ ] **Step 3 : Permissions exécution**

Run: `chmod +x infrastructure/scripts/smoke-chat.sh`

- [ ] **Step 4 : Lancement manuel**

Démarrer toute la stack, exporter `DEMO_USER`, `DEMO_PASS`, `DEMO_WORKSPACE_ID`, `KEYCLOAK_CLIENT_SECRET`. Lancer :
```bash
make smoke-chat
```
Expected: `OK — token reçu via SSE`.

- [ ] **Step 5 : Commit**

```bash
git add infrastructure/scripts/smoke-chat.sh Makefile
git commit -m "test(e2e): smoke-chat — bout-en-bout edge-api → realtime via SSE"
```

---

## Done criteria Phase 1

- [ ] ADR-0006 réécrit (llama.cpp + Mistral) et ADR-0013 publié.
- [ ] Migration Atlas du schéma `conversations` appliquée en local.
- [ ] `inference-router` bascule automatiquement sur Mistral si le backend primaire est down (test d'intégration vert).
- [ ] `ai-core` publie des events `events.<conversationId>` sur NATS (tests unitaires verts).
- [ ] `realtime` expose `GET /sse/v1/conversations/:id/stream` (test vitest vert).
- [ ] `edge-api` expose les mutations `startConversation` et `sendMessage` (tests jest verts).
- [ ] `apps/web` permet à un utilisateur authentifié Keycloak de démarrer une conversation et voir les tokens arriver.
- [ ] `make smoke-chat` retourne `OK` bout-en-bout.

Sortie attendue : screencast de 30 s montrant l'utilisateur tapant un message et la réponse qui se construit token-par-token. Tag `phase-1-walking-skeleton-chat-v1`.

