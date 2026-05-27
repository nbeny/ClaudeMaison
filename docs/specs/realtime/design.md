# realtime — Design

## Endpoints

| Endpoint | Usage Phase 1 | Pourquoi |
|---|---|---|
| `GET /sse/v1/conversations/:conversationId/stream?token=<jwt>` | Chat token streaming | Compatible navigateur (EventSource natif), pas besoin de WS pour du download-only. |
| `GET /ws/v1/stream?token=&channel=` | Conservé pour usage futur (voice mode, multi-canal) | Pas démantelé — la couche hub est réutilisée. |

## Format SSE

Chaque event NATS `events.<conversationId>` est relayé tel quel comme `data: <json>\n\n`. Pas de typage SSE (`event:`) pour rester simple ; le client lit le `type` dans le payload JSON.

## Auth

- Le query param `?token=` contient un JWT Keycloak (browser EventSource n'a pas d'headers custom).
- Vérification de signature par `TokenVerifier` (déjà existant).
- ACL : `claims.sub` doit pouvoir lire la conversation. Pour Phase 1, on vérifie juste que le JWT est valide ; la vérification fine (membre du workspace propriétaire de la conv) est ajoutée Task 16 côté edge-api et exposée via un endpoint `GET /internal/conversations/:id/can-read?userId=…` que `realtime` interroge avant d'ouvrir le flux.

## Heartbeat

Toutes les 15 s : `:keepalive\n\n` (ligne de commentaire SSE) pour empêcher les proxies de fermer la connexion.
