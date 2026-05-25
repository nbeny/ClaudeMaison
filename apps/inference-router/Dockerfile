# syntax=docker/dockerfile:1.7
FROM ghcr.io/astral-sh/uv:0.10.2-python3.12-alpine AS builder
WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-alpine AS runtime
RUN apk add --no-cache wget && \
    addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER app
EXPOSE 4200
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
    CMD wget -qO- http://127.0.0.1:4200/health || exit 1
CMD ["python", "-m", "inference_router.main"]
