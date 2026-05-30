-- ============================================================================
-- Dev-only seed : alice + bob, identités fédérées Keycloak, workspace de démo.
--
-- Joué après 10-schema.sql par docker-entrypoint-initdb.d (ordre lexical),
-- donc uniquement à l'initialisation du volume postgres-data. Pour rejouer :
--   docker compose -f infrastructure/docker/docker-compose.dev.yml down -v
--
-- Les UUIDs sont fixes pour que :
--  - le smoke connaisse DEMO_WORKSPACE_ID = c0c0c0c0-0000-0000-0000-000000000001
--  - les subjects Keycloak (sub) matchent les rows federated_identities sans
--    avoir à scraper le realm après l'import (cf. realm-claudemaison-dev.json
--    où alice/bob ont leur `id` figé sur les mêmes UUIDs).
--
-- ATTENTION : à ne JAMAIS exécuter en prod. Le compose dev est la seule
-- surface où ce script est monté.
-- ============================================================================

INSERT INTO auth.users (id, email, password_hash, locale)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.com', NULL, 'fr-FR'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bob@example.com',   NULL, 'fr-FR')
ON CONFLICT DO NOTHING;

-- Le provider 'oidc' correspond à celui utilisé par
-- apps/edge-api/src/modules/auth/oidc/oidc.controller.ts et par
-- JwtService.verifyAccessToken (chemin RS256 fallback).
INSERT INTO auth.federated_identities (user_id, provider, subject, email, last_login)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'oidc',
   'aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.com', NULL),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'oidc',
   'bbbbbbbb-0000-0000-0000-000000000001', 'bob@example.com',   NULL)
ON CONFLICT DO NOTHING;

INSERT INTO auth.workspaces (id, name, owner_id, plan)
VALUES
  ('c0c0c0c0-0000-0000-0000-000000000001', 'Demo Workspace',
   'aaaaaaaa-0000-0000-0000-000000000001', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO auth.workspace_members (workspace_id, user_id, role)
VALUES
  ('c0c0c0c0-0000-0000-0000-000000000001',
   'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('c0c0c0c0-0000-0000-0000-000000000001',
   'bbbbbbbb-0000-0000-0000-000000000001', 'member')
ON CONFLICT DO NOTHING;
