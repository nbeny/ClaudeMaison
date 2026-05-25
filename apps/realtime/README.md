# `realtime`

Gateway WebSocket/SSE qui diffuse les évènements LLM/agent aux clients.
Fastify nu (pas de NestJS — surface minimale), JWT vérifié au handshake,
fan-out via NATS.

## Pipeline

```
ai-core / workers ──(publish events.<channel>)──> NATS ──(sub events.>)──> realtime ──(WS)──> client
```

Chaque instance realtime abonne au sujet wildcard `events.>` et filtre ses
propres clients via le [`ConnectionHub`](src/ws/hub.ts). Pas d'état partagé
inter-pods — la fan-out est faite côté NATS, chaque pod broadcast à ses
sockets locaux.

## Endpoints

| Endpoint                                  | Rôle                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| `GET /health`                             | Healthcheck pour K8s + Docker (renvoie `{status, connections}`) |
| `WS  /ws/v1/stream?token=...&channel=...` | Souscription à un channel (typ. chatId ou agentRunId)           |

Auth : `token` est un access JWT signé HS256 par edge-api. On valide
`iss`/`aud`/`exp` au handshake et on refuse avec code WS 1008 sinon.

## Dev local

```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile ai up -d nats
cp apps/realtime/.env.example apps/realtime/.env
pnpm --filter realtime dev
```

Test rapide avec `websocat` :

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/signin \
  -d '{"email":"...","password":"..."}' -H 'content-type: application/json' \
  | jq -r .accessToken)
websocat "ws://localhost:3100/ws/v1/stream?token=$TOKEN&channel=demo"
```

Puis depuis un autre terminal, publier dans NATS :

```bash
docker exec -it cm-nats nats pub events.demo '{"hello":"world"}'
```

## Tests

```bash
pnpm --filter realtime test         # unit
pnpm --filter realtime type-check
pnpm --filter realtime lint
```

## Production

Déployé comme binaire séparé du reste de la stack — son profil de charge
(connexions long-lived, CPU léger, mémoire dominée par les buffers WS) est
différent d'edge-api. Le chart Helm sera dans `infrastructure/helm/realtime/`
(à venir, sur le même patron que edge-api).
