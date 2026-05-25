#!/usr/bin/env bash
# Smoke test : boot le stack complet via docker compose, attend que tous les
# /health répondent 200, puis nettoie. Utilisé localement (`bash scripts/smoke.sh`)
# et en CI (.github/workflows/smoke.yml).
#
# Sortie : code 0 si tout est UP, code != 0 sinon. Les logs des conteneurs
# sont dumpés en cas d'échec pour faciliter le diagnostic.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/infrastructure/docker/docker-compose.dev.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --profile apps)

# Endpoints HTTP à vérifier. workers et tools n'ont pas de /health HTTP :
# - tools = gRPC, on vérifie juste que le conteneur tourne.
# - workers = consomme Redis, idem.
# Format : "service|http://host:port/health"
HTTP_CHECKS=(
  "edge-api|http://localhost:3000/health"
  "realtime|http://localhost:3100/health"
  "ai-core|http://localhost:4000/health"
  "retrieval|http://localhost:4100/health"
  "inference-router|http://localhost:4200/health"
)

CONTAINER_CHECKS=(tools workers)

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "::group::Logs (échec)"
    "${COMPOSE[@]}" logs --tail=200 || true
    echo "::endgroup::"
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  exit $exit_code
}
trap cleanup EXIT

echo "→ build + up"
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300

# Les --wait du compose ne s'appliquent qu'aux services avec healthcheck défini.
# On double-check à la main pour les endpoints HTTP (le healthcheck Docker
# peut être OK avant que l'app accepte les requêtes — race).
echo "→ vérification des /health"
for entry in "${HTTP_CHECKS[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"
  echo -n "  $name ($url) "
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      echo "OK"
      break
    fi
    if [[ $attempt -eq 30 ]]; then
      echo "FAIL"
      exit 1
    fi
    sleep 2
  done
done

echo "→ vérification des conteneurs sans HTTP"
for name in "${CONTAINER_CHECKS[@]}"; do
  status="$("${COMPOSE[@]}" ps --format '{{.State}}' "$name" 2>/dev/null || echo missing)"
  echo "  $name → $status"
  if [[ "$status" != "running" ]]; then
    echo "FAIL: $name n'est pas running"
    exit 1
  fi
done

echo "✓ Smoke OK"
