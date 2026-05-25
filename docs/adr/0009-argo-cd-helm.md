# ADR-0009 — Argo CD + Helm pour le déploiement

## Statut

Accepté — 2026-05-24

## Contexte

Besoin d'un système de déploiement Kubernetes qui soit déclaratif, observable, multi-environnements, avec rollback rapide et gestion de canary.

## Décision

- **Helm 3** pour packager chaque service (1 chart par service, valeurs par environnement).
- **Argo CD** comme contrôleur GitOps sur chaque cluster, source de vérité = `infrastructure/kubernetes/` du monorepo.
- **Argo Rollouts** pour les stratégies avancées (canary, blue/green, analyse automatique).

Flow :

1. PR mergée sur `main` qui touche `infrastructure/kubernetes/<env>/` → Argo détecte et synchronise.
2. dev / staging : sync automatique.
3. prod : sync manuel via UI Argo (gate humaine) pour services critiques, auto pour services non-critiques.

## Alternatives considérées

- **Flux CD** — équivalent fonctionnel ; Argo gagne pour son UI plus mûre et la communauté plus active.
- **Kustomize seul** — rejeté : pas assez expressif pour templating multi-env.
- **Pulumi / Crossplane** — overkill pour le besoin actuel.

## Conséquences

**Positives** :

- État du cluster = état du repo. Audit trivial.
- Rollback = revert de commit.
- UI Argo donne une vue temps-réel des déploiements et de la santé.

**Négatives** :

- Helm a ses warts (templating en YAML/Go = fragile sur les charts complexes).
- Argo lui-même devient un composant critique à monitorer.

**Engagements** :

- Charts simples, valeurs explicites par environnement.
- Tests `helm lint` et `helm template` en CI sur toute modification de chart.
- Procédure de DR pour Argo lui-même documentée (runbook).
