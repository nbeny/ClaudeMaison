# tools

Tool execution service (gRPC). Jour-1 : exécution in-process avec timeout.
Jour-2 : sandbox Firecracker — voir ADR-0009.

## Stack

- Python 3.12, grpcio (async), httpx
- Outils built-in : `echo`, `http_get`

## Bootstrap

```bash
uv sync --extra dev
uv run bash scripts/gen-proto.sh   # génère les stubs Python à partir du .proto
cp .env.example .env
uv run python -m tools.main
```

## gRPC

```
service ToolService {
  rpc ExecuteTool(ExecuteToolRequest) returns (ExecuteToolResponse);
  rpc ListTools(ListToolsRequest) returns (ListToolsResponse);
}
```

Voir `proto/tools.proto` pour le contrat exact. Les stubs sont régénérés à
chaque build d'image Docker.

## Tests

```bash
uv run pytest               # executor + registry, indépendant des stubs gRPC
uv run ruff check . && uv run ruff format --check .
uv run mypy src
```

## Limites Jour-1

- Pas de sandbox. Les outils tournent dans le process serveur — usage interne uniquement.
- Pas d'allowlist `http_get`. À ajouter avant exposition.
- Pas de healthcheck gRPC (`grpc_health_probe` à wirer).
