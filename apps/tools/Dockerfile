# syntax=docker/dockerfile:1.7
# Build : uv + génération des stubs gRPC. Runtime : python alpine.

FROM ghcr.io/astral-sh/uv:0.10.2-python3.12-alpine AS builder
WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never
RUN apk add --no-cache bash
COPY pyproject.toml uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
COPY proto ./proto
COPY scripts ./scripts
COPY src ./src
RUN bash scripts/gen-proto.sh
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-alpine AS runtime
RUN apk add --no-cache libstdc++ && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER app
EXPOSE 5005
# Pas de healthcheck HTTP — c'est du gRPC. grpc_health_probe arrivera plus tard.
CMD ["python", "-m", "tools.main"]
