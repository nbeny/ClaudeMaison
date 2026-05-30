#!/usr/bin/env bash
# Télécharge le GGUF Mistral utilisé par llama.cpp en Phase 1 et le dépose
# dans le volume Docker `claudemaison-dev_llama-models` que monte le service
# `llama-cpp` (cf. infrastructure/docker/docker-compose.dev.yml, profil gpu).
#
# Pourquoi un container curl plutôt que `docker compose exec llama-cpp curl …` ?
#   - le mount `llama-models:/models:ro` est read-only côté llama-cpp ;
#   - l'image llama.cpp:server-rocm n'embarque pas curl.
# On contourne avec un container éphémère `curlimages/curl` qui a accès en
# RW au volume nommé.
#
# Idempotent : si le fichier est déjà présent dans le volume, le script sort
# en succès sans retélécharger (≈ 4 Go).
set -euo pipefail

# Nom du projet docker compose (préfixe `name:` dans docker-compose.dev.yml).
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-claudemaison-dev}"
VOLUME="${PROJECT_NAME}_llama-models"
MODEL_FILE='mistral-7b-instruct-v0.3.Q4_K_M.gguf'
MODEL_URL="${MODEL_URL:-https://huggingface.co/MaziyarPanahi/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3.Q4_K_M.gguf}"

# S'assurer que le volume existe (créé automatiquement au premier `compose up`,
# mais on peut tomber ici avant tout `up` — `docker volume create` est idempotent).
docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null

# Test idempotent dans un container éphémère.
if docker run --rm -v "$VOLUME:/models" alpine:3.20 \
     test -s "/models/$MODEL_FILE"; then
  echo "→ $MODEL_FILE déjà présent dans le volume $VOLUME, rien à faire."
  exit 0
fi

echo "→ téléchargement de $MODEL_FILE (~4 Go) dans le volume $VOLUME"
docker run --rm -v "$VOLUME:/models" curlimages/curl:8.10.1 \
  -fL --retry 3 --retry-delay 2 \
  -o "/models/$MODEL_FILE" \
  "$MODEL_URL"

echo "→ OK. Relance llama-cpp pour qu'il monte le modèle :"
echo "   docker compose -f infrastructure/docker/docker-compose.dev.yml restart llama-cpp"
