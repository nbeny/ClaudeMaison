# `apps/`

Services applicatifs et clients déployables.

Chaque sous-dossier correspond à un service logique du document d'architecture
([Partie III](../docs/architecture/2026-05-24-architecture-souveraine.md#partie-iii--décomposition-en-services)).

## Services prévus

Six binaires Jour-1 (regroupent les services logiques) — colonne « binaire »
indique le binaire d'accueil au Jour-1.

| Dossier                 | Binaire Jour-1     | Stack                    | Statut       |
| ----------------------- | ------------------ | ------------------------ | ------------ |
| `web/`                  | —                  | Next.js 15 + Apollo      | à créer      |
| `mobile/`               | —                  | React Native + Expo      | à créer      |
| `edge-api/`             | edge-api           | NestJS (GraphQL/REST/gRPC) | Day-1 ready  |
| `realtime/`             | realtime           | Fastify + ws + NATS      | scaffold     |
| `ai-core/`              | ai-core            | Python + FastAPI         | à créer      |
| `retrieval/`            | retrieval          | Python                   | à créer      |
| `tools/`                | tools              | Python + Firecracker     | à créer      |
| `workers/`              | workers            | Python (Arq)             | à créer      |
| `inference-router/`     | inference-router   | Python                   | à créer      |

## Groupement de déploiement (Jour-1)

Quinze services _logiques_, **six binaires déployés** au Jour-1 :
voir [Partie III §3.2](../docs/architecture/2026-05-24-architecture-souveraine.md#32-stratégie-de-déploiement-jour-1-vs-jour-n).
