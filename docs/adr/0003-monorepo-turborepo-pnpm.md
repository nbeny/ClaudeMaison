# ADR-0003 — Monorepo Turborepo + pnpm

## Statut

Accepté — 2026-05-24

## Contexte

15 services logiques, beaucoup de code partagé (types, prompts, SDK, UI). En multi-repo, la coordination des changements transversaux devient un goulet d'étranglement : un changement de schéma GraphQL toucherait 5 dépôts, 5 PRs, 5 cycles de revue.

## Décision

**Un seul dépôt** pour tout : apps, services, packages partagés, IaC, docs.

- **pnpm workspaces** pour les dépendances JavaScript/TypeScript (efficient en disque, strict sur les hoists).
- **Turborepo 2** pour l'orchestration de tâches et le cache (remote cache auto-hébergé sur MinIO).
- **uv** (Astral) pour les dépendances Python : rapide, lockfile reproductible, gère plusieurs versions Python.

## Alternatives considérées

- **Nx** — rejeté : trop opinionant, génère beaucoup de boilerplate, courbe d'apprentissage plus raide.
- **Multi-repo classique** — rejeté : coordination intolérable au stade d'une petite équipe.
- **Yarn workspaces / npm workspaces** — rejetés : pnpm est strictement plus rapide et plus strict.

## Conséquences

**Positives** :
- Refactor transversaux atomiques.
- Cache de build partagé entre développeurs et CI.
- Versionnement unifié des packages partagés.

**Négatives** :
- CI plus complexe (détection sélective des packages touchés).
- Taille du dépôt qui croît avec l'historique.
- Onboarding initial un peu plus lourd (comprendre Turborepo + pnpm).

**Engagements** :
- Activer le remote cache Turborepo dès qu'on a plus de 3 développeurs ou un CI lent.
- Documenter `turbo run … --filter='…[origin/main]'` dans les pipelines.
