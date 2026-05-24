-- Schéma déclaratif consommé par Atlas.
-- Source de vérité : ce fichier. Les migrations sont générées par diff.
--
-- Convention : un schéma Postgres par bounded context métier.
-- Le binaire `edge-api` possède `auth` et `billing` (étape 4).

CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS auth;

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
