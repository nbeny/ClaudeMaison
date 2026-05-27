-- Schéma déclaratif consommé par Atlas.
-- Source de vérité : ce fichier. Les migrations sont générées par diff.
--
-- Convention : un schéma Postgres par bounded context métier.
-- Le binaire `edge-api` possède `auth` et `billing`.

-- Extensions Postgres (citext, pgcrypto) provisionnées hors d'Atlas :
-- voir infrastructure/db/init/00-extensions.sql (initdb du conteneur dev)
-- et la doc d'opérations pour le provisioning en prod.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS billing;

-- ---------------------------------------------------------------------------
-- auth.users
-- ---------------------------------------------------------------------------
CREATE TABLE auth.users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         CITEXT NOT NULL,
    password_hash TEXT,  -- NULL si l'utilisateur n'a qu'une identité OIDC (étape 3)
    locale        TEXT NOT NULL DEFAULT 'fr-FR',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

-- Email unique parmi les comptes vivants. On garde les soft-deletes pour audit
-- mais on autorise la réutilisation de l'adresse une fois le compte purgé.
CREATE UNIQUE INDEX users_email_active_idx
    ON auth.users (email)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- auth.workspaces
-- ---------------------------------------------------------------------------
CREATE TABLE auth.workspaces (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    plan       TEXT NOT NULL DEFAULT 'free',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX workspaces_owner_idx ON auth.workspaces (owner_id);

-- ---------------------------------------------------------------------------
-- auth.workspace_members
-- ---------------------------------------------------------------------------
CREATE TABLE auth.workspace_members (
    workspace_id UUID NOT NULL REFERENCES auth.workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON auth.workspace_members (user_id);

-- ---------------------------------------------------------------------------
-- auth.sessions
-- Une session = un refresh token actif. On ne stocke jamais le token clair,
-- uniquement son hash SHA-256 (le token reste côté client).
-- ---------------------------------------------------------------------------
CREATE TABLE auth.sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    refresh_token_hash  BYTEA NOT NULL,
    user_agent          TEXT,
    ip                  INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    -- Rotation : quand un refresh est utilisé, on crée une nouvelle session
    -- et on pointe l'ancienne vers la nouvelle. Si la nouvelle est utilisée
    -- pour rafraîchir alors que l'ancienne est rejouée → vol détecté,
    -- révocation en cascade.
    rotated_to          UUID REFERENCES auth.sessions(id)
);

CREATE UNIQUE INDEX sessions_refresh_hash_idx ON auth.sessions (refresh_token_hash);
CREATE INDEX sessions_user_active_idx
    ON auth.sessions (user_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- auth.federated_identities
-- Liens entre un user local et son identité chez un provider OIDC externe.
-- Un user peut avoir plusieurs identités (Keycloak, Google enterprise, …) ;
-- une identité (provider, subject) est unique et ne peut pointer qu'à un user.
-- ---------------------------------------------------------------------------
CREATE TABLE auth.federated_identities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,         -- ex: 'keycloak', 'google', 'github'
    subject     TEXT NOT NULL,         -- claim `sub` du provider, stable
    email       CITEXT,                -- email rapporté par le provider au lien
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login  TIMESTAMPTZ
);

CREATE UNIQUE INDEX federated_identities_provider_subject_idx
    ON auth.federated_identities (provider, subject);
CREATE INDEX federated_identities_user_idx
    ON auth.federated_identities (user_id);

-- ===========================================================================
-- Schéma billing : plans, abonnements, événements d'usage.
--
-- Source d'écriture des `usage_events` : `ai-core` via gRPC (binaire séparé,
-- pas Jour-1). Source de lecture : ce binaire (`edge-api`) pour exposer les
-- quotas restants au front et pour répondre aux CheckQuota gRPC.
--
-- Quotas : tous exprimés en unité native, par cycle de facturation
-- (current_period_start/end sur la subscription). Conventions :
--   - NULL  → ressource non-mesurée pour ce plan
--   - -1    → illimité
--   - >= 0  → plafond strict
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- billing.plans
-- ---------------------------------------------------------------------------
CREATE TABLE billing.plans (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                    TEXT NOT NULL UNIQUE,
    name                    TEXT NOT NULL,
    description             TEXT,
    -- Limites par cycle. BIGINT pour les tokens (peut dépasser 2^31 sur
    -- les plans entreprise), NUMERIC pour le stockage (fractions de Go).
    quota_llm_tokens        BIGINT,
    quota_embeddings_tokens BIGINT,
    quota_tool_runs         BIGINT,
    quota_storage_gb        NUMERIC(12, 2),
    -- Prix indicatif. Le module billing ne facture pas Jour-1 — il sera
    -- branché à un PSP EU plus tard. On garde la colonne pour cohérence
    -- d'affichage côté front.
    price_eur_month_micro   BIGINT NOT NULL DEFAULT 0,
    is_public               BOOLEAN NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- billing.subscriptions
-- Une seule subscription active par workspace : indexes uniques partiels.
-- ---------------------------------------------------------------------------
CREATE TABLE billing.subscriptions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID NOT NULL REFERENCES auth.workspaces(id) ON DELETE CASCADE,
    plan_id              UUID NOT NULL REFERENCES billing.plans(id) ON DELETE RESTRICT,
    status               TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'cancelled')),
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end   TIMESTAMPTZ NOT NULL,
    cancelled_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_period_chk CHECK (current_period_end > current_period_start)
);

CREATE UNIQUE INDEX subscriptions_workspace_active_idx
    ON billing.subscriptions (workspace_id)
    WHERE status = 'active';

CREATE INDEX subscriptions_plan_idx ON billing.subscriptions (plan_id);

-- ---------------------------------------------------------------------------
-- billing.usage_events
--
-- Écrit par `ai-core` (et plus tard `tools`, `retrieval`) via gRPC. Pas de FK
-- sur `auth.workspaces` : le couplage est volontairement faible pour que les
-- événements survivent à une migration/séparation des binaires et qu'on puisse
-- accepter une écriture même si l'enregistrement de la workspace n'est pas
-- visible (lag de réplication, par exemple).
--
-- L'idempotence est garantie par `idempotency_key` (UNIQUE). L'appelant
-- gRPC peut réémettre une batch entière sans risque de double-comptage.
-- ---------------------------------------------------------------------------
CREATE TABLE billing.usage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL,
    workspace_id    UUID NOT NULL,
    user_id         UUID,
    kind            TEXT NOT NULL CHECK (kind IN (
        'llm_tokens', 'embeddings_tokens', 'tool_runs', 'storage_gb_day'
    )),
    quantity        NUMERIC NOT NULL CHECK (quantity >= 0),
    unit            TEXT NOT NULL,
    cost_eur_micro  BIGINT NOT NULL DEFAULT 0,
    metadata        JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX usage_events_idempotency_idx
    ON billing.usage_events (idempotency_key);

-- Index principal de requête : agrégation d'usage par workspace + kind
-- sur une fenêtre temporelle (la période de facturation courante).
CREATE INDEX usage_events_workspace_kind_occurred_idx
    ON billing.usage_events (workspace_id, kind, occurred_at);

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

