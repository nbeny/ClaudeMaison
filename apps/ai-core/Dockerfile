# syntax=docker/dockerfile:1.7
# Construit depuis la racine du dépôt :
#   docker build -f apps/ai-core/Dockerfile -t ai-core:dev .
#
# On utilise uv comme installateur (resolver lockfile, plus rapide que pip).
# Multi-stage : builder résout les deps + lock, runtime n'a que le venv.

FROM ghcr.io/astral-sh/uv:0.10.2-python3.12-alpine AS builder

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Resolution des deps en couche séparée pour bénéficier du cache Docker.
COPY apps/ai-core/pyproject.toml ./
COPY apps/ai-core/uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev || uv sync --no-install-project --no-dev

COPY apps/ai-core/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev || uv sync --no-dev

FROM python:3.12-alpine AS runtime

ENV PATH=/app/.venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# uvicorn[standard] dépend de uvloop et httptools — pas de wheels musl pour
# tout, donc on installe les buildtools nécessaires puis on purge.
RUN apk add --no-cache libstdc++ \
    && addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=builder --chown=app:app /app /app

USER app
EXPOSE 4000
EXPOSE 5002
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q -O /dev/null http://localhost:4000/health || exit 1
CMD ["ai-core"]
