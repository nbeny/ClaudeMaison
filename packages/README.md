# `packages/`

Code partagé entre apps. Aucun import croisé entre `apps/` n'est autorisé — tout partage passe par un package.

## Packages prévus

| Dossier           | Rôle                                                                   | Statut  |
| ----------------- | ---------------------------------------------------------------------- | ------- |
| `shared-types/`   | types GraphQL/Proto générés + DTO TS                                   | à créer |
| `shared-ai/`      | helpers LLM (tokenizers, comptage de tokens, schémas Pydantic communs) | à créer |
| `shared-prompts/` | templates de prompts **versionnés** avec tests d'évaluation            | à créer |
| `shared-agents/`  | définitions d'agents partagées entre orchestrateur et runtime          | à créer |
| `shared-tools/`   | définitions d'outils (schémas JSON, permissions)                       | à créer |
| `sdk/`            | SDK client TypeScript public                                           | à créer |
| `ui/`             | composants React partagés (Tailwind)                                   | à créer |
| `config/`         | configs ESLint, Prettier, tsconfig, ruff                               | à créer |

## Règles

- `shared-types/` est **généré**, jamais édité à la main.
- `shared-prompts/` : changement de prompt = bump de version + changelog. Les prompts sont des artefacts versionnés avec tests.
- Tout package exporte via un `package.json` propre avec `exports` map.
