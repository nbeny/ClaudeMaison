# Chart Helm — inference-router

Chart de déploiement du binaire `inference-router` : proxy OpenAI-compatible
qui route les requêtes `/v1/chat/completions` vers les backends LLM avec
round-robin par modèle.

## Installation

```bash
helm install inference-router ./infrastructure/helm/inference-router \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  --set config.MODEL_BACKENDS='llama-3.1-8b=http://vllm-llama.llm.svc:8000' \
  -f values-prod.yaml
```

## Pré-requis

| Ressource                           | Pourquoi                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| Secret `inference-router-secrets`   | INFERENCE_API_KEY si les backends exigent un Bearer.                |
| Backends LLM (vLLM, llama-cpp, ...) | Déployés et exposés en cluster.                                     |
| metrics-server                      | Si `autoscaling.enabled=true`                                       |

## Spécificités

- **Pas d'ingress par défaut** : interne (ai-core consomme). Activer
  uniquement pour debug.
- **`MODEL_BACKENDS` obligatoire** : sans config valide, le router renvoie
  404 sur chaque modèle inconnu → ai-core remonte "modèle indisponible".
  Mettre à jour en valeurs prod en cohérence avec les modèles servis.
- **Streaming chunked** : `aiter_raw()` forwarde la SSE telle quelle. La
  termination grace period (30s) couvre les requêtes longues en cours.

## Variables critiques

| Clé                          | Défaut               | Remarque                                                        |
| ---------------------------- | -------------------- | --------------------------------------------------------------- |
| `image.tag`                  | `""`                 | Setter via CI.                                                  |
| `config.MODEL_BACKENDS`      | `""`                 | **OBLIGATOIRE** en prod. Format `model=url1,url2;model2=url3`.  |
| `config.REQUEST_TIMEOUT_S`   | `"120"`              | Augmenter si modèles avec gros context window (long TTFT).      |

## Lint

```bash
helm lint ./infrastructure/helm/inference-router
```
