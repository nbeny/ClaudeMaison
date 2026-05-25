# ADR-0004 — 15 services logiques, 6 binaires déployés au Jour-1

## Statut

Accepté — 2026-05-24

## Contexte

Le document d'architecture identifie 15 services logiques. Déployer 15 binaires distincts dès le Jour-1 avec une petite équipe est un piège classique : trop de surfaces à monitorer, à déployer, à versionner, à débugger en cross-service, pour des frontières qui ne sont pas encore prouvées par la charge.

## Décision

**Décomposition logique** (modules) ≠ **décomposition de déploiement** (binaires).

**Six binaires au Jour-1**, regroupant les modules par profil de charge et frontière de sécurité :

| Binaire     | Modules regroupés                                |
| ----------- | ------------------------------------------------ |
| `edge-api`  | api-gateway + auth-service + billing-service     |
| `ai-core`   | ai-orchestrator + agent-runtime + memory-service |
| `retrieval` | rag-service + embedding-service                  |
| `tools`     | tool-service (isolé pour sandboxing)             |
| `realtime`  | realtime-service (isolé pour profil de charge)   |
| `workers`   | worker-ingestion + worker-summarisation          |

Plus, sur le plan d'inférence : `inference-router` + N instances vLLM.

## Critères d'extraction d'un module en service séparé

Un module est extrait quand **au moins un** des critères suivants est rempli :

- Profil de charge divergent (CPU vs IO vs GPU).
- Frontière de sécurité (tool-service extrait dès le Jour-1 pour cette raison).
- Équipe dédiée prête à le posséder.
- SLO différent (realtime a des exigences de latence propres).

Tant qu'aucun critère n'est rempli, on garde le module dans son binaire.

## Alternatives considérées

- **15 binaires dès le Jour-1** — rejeté : explosion des coûts ops, frontières arbitraires.
- **Monolithe unique** — rejeté : sandboxing des tools impossible, hétérogénéité Node/Python ingérable, scaling impossible à grain fin.

## Conséquences

**Positives** :

- 6 déploiements à surveiller au lieu de 15.
- Communication intra-binaire = appel de fonction (rapide).
- Décomposition logique préservée → extraction future = opération mécanique.

**Négatives** :

- Tentation de bypasser les frontières logiques → nécessite discipline (revue de code).
- Un binaire qui crash emporte plusieurs modules.

**Engagements** :

- Aucune import croisé entre modules d'un même binaire sauf via leur API publique déclarée.
- Logs et métriques portent toujours le nom du **module**, pas seulement du binaire.
