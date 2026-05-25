# Chart Helm — ai-core

Chart de déploiement du binaire `ai-core` (orchestrateur de conversations
LLM, boucle agentique).

## Installation

```bash
helm install ai-core ./infrastructure/helm/ai-core \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Pré-requis

| Ressource                    | Pourquoi                                                                |
| ---------------------------- | ----------------------------------------------------------------------- |
| Secret `ai-core-secrets`     | INFERENCE_API_KEY (Bearer pour inference-router), autres credentials.   |
| inference-router déployé     | `LLM_BASE_URL` doit y pointer ; sans ça, chaque chat renvoie "indispo". |
| retrieval déployé            | `RETRIEVAL_URL` pour le RAG (optionnel selon les routes utilisées).     |
| metrics-server               | Si `autoscaling.enabled=true`                                           |

## Variables critiques

| Clé                        | Défaut                                                  | Remarque                                              |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `image.tag`                | `""`                                                    | Setter via CI.                                        |
| `config.LLM_BASE_URL`      | `http://inference-router.claudemaison.svc:4200/v1`      | Doit pointer vers le service inference-router.        |
| `config.LLM_TIMEOUT_S`     | `"120"`                                                 | Augmenter si gros context window LLM.                 |
| `config.RETRIEVAL_URL`     | `http://retrieval.claudemaison.svc:4100`                | Service retrieval pour RAG.                           |

## Spécificités

- `terminationGracePeriodSeconds: 60` : laisse les boucles agentiques en
  cours finir (multi-tours = quelques secondes par appel LLM).
- `scaleDown.stabilizationWindowSeconds: 600` : on évite de tuer un pod
  qui pourrait avoir une conversation en streaming.

## Lint

```bash
helm lint ./infrastructure/helm/ai-core
```
