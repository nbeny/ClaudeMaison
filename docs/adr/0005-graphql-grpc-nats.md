# ADR-0005 — GraphQL côté client, gRPC interne, NATS asynchrone

## Statut

Accepté — 2026-05-24

## Contexte

Trois besoins de communication distincts :

1. Surface riche pour les clients web/mobile (multi-ressources, sélection de champs).
2. Appels synchrones internes entre services typés, performants.
3. Communication asynchrone entre orchestrateur et agents (fan-out, retry, durabilité).

Un seul protocole ne convient pas aux trois.

## Décision

| Style              | Usage                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------- |
| **GraphQL**        | Façade unique pour les clients (web, mobile). Schéma fédéré par domaine.                    |
| **REST**           | Endpoints simples (upload de fichiers, webhooks entrants, intégrations tierces).            |
| **gRPC**           | Communication synchrone interne entre services. Schémas `.proto` versionnés.                |
| **SSE**            | Streaming tokens / évènements _serveur vers client_. Plus simple que WS, suffit pour 1-way. |
| **WebSocket**      | Bidirectionnel temps-réel uniquement (mode voix, collab multi-utilisateurs).                |
| **NATS JetStream** | Asynchrone interne : tâches d'agents, fan-out d'évènements, retry durables.                 |

## Alternatives considérées

- **REST partout** — rejeté : typage faible, pas de streaming, pas de bidirectionnel propre.
- **gRPC côté client (gRPC-Web)** — rejeté : DX médiocre côté web, sélection de champs absente.
- **Kafka au lieu de NATS** — envisagé ; NATS JetStream gagne pour notre échelle (plus simple à opérer, latence plus basse, suffisant en débit pour 1M+ utilisateurs).

## Conséquences

**Positives** :

- Chaque protocole sert là où il excelle.
- Streaming natif et propre via SSE.
- Découplage temporel des agents via NATS.

**Négatives** :

- Trois schémas à maintenir (GraphQL SDL, `.proto`, NATS subjects).
- Génération de types croisée nécessaire (résolue par `shared-types`).

**Engagements** :

- Tout schéma est généré, jamais édité à la main côté client.
- Versionnement avec déprécation préalable (1 release minimum) pour tout breaking change.
