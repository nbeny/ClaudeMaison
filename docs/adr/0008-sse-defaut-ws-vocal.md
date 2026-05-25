# ADR-0008 — SSE par défaut, WebSocket pour vocal et collab

## Statut

Accepté — 2026-05-24

## Contexte

Streaming des réponses LLM vers le client : il faut un protocole serveur-vers-client à faible latence, traversant proxys et load-balancers, reconnectable.

SSE (Server-Sent Events) et WebSocket sont les deux options sérieuses. Beaucoup d'équipes choisissent WS par habitude alors que SSE suffit pour la majorité des cas.

## Décision

- **SSE par défaut** pour tout streaming serveur-vers-client : tokens de réponse, évènements d'agents, statuts d'outils.
- **WebSocket** uniquement pour les cas qui ont besoin de bidirectionnel à faible latence : **mode vocal** (audio in/out continu), **collaboration multi-utilisateurs** sur un workspace.

## Alternatives considérées

- **WebSocket partout** — rejeté : complexité accrue (reconnexion manuelle, heartbeats, frame management) pour aucun bénéfice en 1-way.
- **HTTP long-polling** — rejeté : démodé, mauvaise expérience.
- **gRPC-Web streaming** — rejeté : moins bien supporté que SSE dans les proxys EU.

## Conséquences

**Positives** :

- Implémentation client triviale (`EventSource` natif navigateur).
- Reconnexion automatique avec `Last-Event-ID`.
- Compatible avec tous les proxys HTTP standard.

**Négatives** :

- Limite browser de ~6 connexions SSE par domaine → mitigé par HTTP/2 (multiplexing).
- Pas de bidirectionnel → impose WS pour les cas voix/collab (acceptable).

**Engagements** :

- Tout évènement streamé porte un ID monotone pour permettre la reprise.
- Buffer Redis Stream conservé 1 heure pour permettre reconnexion ; au-delà, fallback REST `GET /conversations/:id/messages?since=…`.
