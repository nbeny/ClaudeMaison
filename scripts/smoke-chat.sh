#!/usr/bin/env bash
# Smoke E2E Phase 1 : démarre la stack puis vérifie que le chemin complet
# (edge-api → ai-core → inference-router → llama.cpp/Mistral → NATS → realtime)
# délivre au moins un token SSE en moins de 30 s.
#
# Pré-requis :
#   - stack démarrée (docker compose --profile oidc --profile apps --profile gpu up -d)
#   - llama.cpp healthy avec le modèle GGUF téléchargé (cf. apps/inference-router/README.md)
#   - volume postgres-data initial : infrastructure/db/init/20-dev-seed.sql crée
#     alice/bob + federated_identities (UUIDs alignés sur realm Keycloak) +
#     workspace c0c0c0c0-…-0001 dont alice est owner. Si tu viens d'une version
#     antérieure du repo, `docker compose -f infrastructure/docker/docker-compose.dev.yml down -v`
#     pour rejouer l'initdb.
#   - edge-api et realtime tournent en mode dual JWT : ils acceptent à la fois
#     les tokens HS256 internes et les access tokens RS256 émis par Keycloak.
#     Le smoke ci-dessous utilise directement l'access token Keycloak.
#   - var d'env DEMO_USER (default: alice) + DEMO_PASS (default: alice-password)
set -euo pipefail

GRAPHQL_URL="${GRAPHQL_URL:-http://localhost:3000/graphql}"
REALTIME_URL="${REALTIME_URL:-http://localhost:3100}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${KEYCLOAK_REALM:-claudemaison-dev}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:-edge-api}"
CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-edge-api-dev-secret-change-in-prod}"
DEMO_USER="${DEMO_USER:-alice}"
DEMO_PASS="${DEMO_PASS:-alice-password}"
# Default = workspace seedé par infrastructure/db/init/20-dev-seed.sql.
# Override pour un autre workspace (alice doit y être membre).
DEMO_WORKSPACE_ID="${DEMO_WORKSPACE_ID:-c0c0c0c0-0000-0000-0000-000000000001}"

echo '→ obtention token Keycloak'
ACCESS_TOKEN=$(curl -s -X POST \
  "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "grant_type=password" \
  -d "username=$DEMO_USER" \
  -d "password=$DEMO_PASS" | jq -r .access_token)
test -n "$ACCESS_TOKEN" && test "$ACCESS_TOKEN" != "null" || { echo 'token KO'; exit 1; }

echo '→ création de conversation'
START_PAYLOAD=$(jq -nc --arg ws "$DEMO_WORKSPACE_ID" \
  '{query: "mutation { startConversation(workspaceId: \"\($ws)\") }"}')
CONV_ID=$(curl -s -X POST "$GRAPHQL_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "$START_PAYLOAD" \
  | jq -r '.data.startConversation')
test -n "$CONV_ID" && test "$CONV_ID" != "null" || { echo 'conv KO'; exit 1; }
echo "conv = $CONV_ID"

echo '→ ouverture SSE en arrière-plan'
SSE_OUT=$(mktemp)
( timeout 30 curl -sN \
    "$REALTIME_URL/sse/v1/conversations/$CONV_ID/stream?token=$ACCESS_TOKEN" \
    > "$SSE_OUT" || true ) &
SSE_PID=$!
sleep 1

echo '→ envoi du message'
SEND_PAYLOAD=$(jq -nc --arg id "$CONV_ID" --arg content 'Bonjour' \
  '{query: "mutation { sendMessage(conversationId: \"\($id)\", content: \"\($content)\") { assistantMessageId } }"}')
curl -s -X POST "$GRAPHQL_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "$SEND_PAYLOAD" \
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
