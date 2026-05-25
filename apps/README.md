# `apps/`

Services applicatifs et clients déployables.

Chaque sous-dossier correspond à un service logique du document d'architecture
([Partie III](../docs/architecture/2026-05-24-architecture-souveraine.md#partie-iii--décomposition-en-services)).

## Services prévus

| Dossier                 | Type    | Stack                    | Statut  |
| ----------------------- | ------- | ------------------------ | ------- |
| `web/`                  | client  | Next.js 15 + Apollo      | à créer |
| `mobile/`               | client  | React Native + Expo      | à créer |
| `api-gateway/`          | service | NestJS (GraphQL/REST/WS) | à créer |
| `auth-service/`         | service | NestJS                   | à créer |
| `billing-service/`      | service | NestJS                   | à créer |
| `realtime-service/`     | service | Fastify + ws             | à créer |
| `ai-orchestrator/`      | service | Python + FastAPI         | à créer |
| `agent-runtime/`        | service | Python                   | à créer |
| `tool-service/`         | service | Python + Firecracker     | à créer |
| `memory-service/`       | service | Python                   | à créer |
| `rag-service/`          | service | Python                   | à créer |
| `embedding-service/`    | service | Python                   | à créer |
| `inference-router/`     | service | Python                   | à créer |
| `worker-ingestion/`     | worker  | Python (Arq)             | à créer |
| `worker-summarisation/` | worker  | Python (Arq)             | à créer |

## Groupement de déploiement (Jour-1)

Quinze services _logiques_, **six binaires déployés** au Jour-1 :
voir [Partie III §3.2](../docs/architecture/2026-05-24-architecture-souveraine.md#32-stratégie-de-déploiement-jour-1-vs-jour-n).
