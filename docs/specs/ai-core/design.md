# ai-core — Design

## Streaming des tokens (Phase 1)

### Flux

```
client (apps/web)
  └─ EventSource → realtime (SSE)
                     └─ NATS subscribe events.<conversationId>
                                                ↑
                                                │ publish
                              ai-core ──────────┘
                                  │
                                  ├─ httpx stream → inference-router → llama.cpp/Mistral
                                  └─ persist message final → edge-api (HTTP PUT /internal/messages/:id)
```

### Sujets NATS

- `events.<conversationId>` — un event JSON par token ou par évènement de cycle :

```json
{"type": "token", "messageId": "uuid", "delta": "Hel"}
{"type": "token", "messageId": "uuid", "delta": "lo"}
{"type": "done",  "messageId": "uuid", "finishReason": "stop", "tokensIn": 42, "tokensOut": 7}
{"type": "error", "messageId": "uuid", "reason": "all_backends_failed"}
```

- Pas de JetStream ; les events sont best-effort. Si le client perd le SSE en plein milieu, le message final est lisible via `GET /chat/{id}` une fois `type=done` persisté côté edge-api.

### Endpoint ai-core

`POST /v1/chat/turn/stream` — appelé par edge-api juste après avoir persisté le message user. Body :

```json
{
  "conversationId": "uuid",
  "workspaceId": "uuid",
  "userId": "uuid",
  "messageId": "uuid",
  "model": "mistral-7b-instruct-q4",
  "history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

Réponse : `202 Accepted` immédiat. Tout le streaming sort par NATS.
