# Chart Helm — retrieval

Chart de déploiement du binaire `retrieval` (RAG : indexation et recherche
vectorielle via Qdrant).

## Installation

```bash
helm install retrieval ./infrastructure/helm/retrieval \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Pré-requis

| Ressource                   | Pourquoi                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| Secret `retrieval-secrets`  | QDRANT_API_KEY si Qdrant Cloud, autres credentials embedding model. |
| Qdrant (cluster-interne)    | Service `qdrant.data.svc:6333` (ou Qdrant Cloud avec API key).      |
| metrics-server              | Si `autoscaling.enabled=true`                                       |

## Spécificités

- **Pas d'ingress par défaut** : retrieval est interne (ai-core /v1/search,
  workers /v1/index). N'exposer hors-cluster que pour debug.
- **`runAsUser` non set** : Dockerfile utilise `adduser -S` (UID dynamique
  busybox). Le runtime résout via image USER. Pour pinner en prod, fixer
  l'UID dans le Dockerfile et override `podSecurityContext.runAsUser` ici.
- `EMBED_DIM` doit matcher la collection Qdrant existante (sinon recréation
  à coût élevé en prod — déconseillé).

## Variables critiques

| Clé                          | Défaut                            | Remarque                                              |
| ---------------------------- | --------------------------------- | ----------------------------------------------------- |
| `image.tag`                  | `""`                              | Setter via CI.                                        |
| `config.QDRANT_URL`          | `http://qdrant.data.svc:6333`     | Override si Qdrant hors-cluster.                      |
| `config.QDRANT_COLLECTION`   | `claudemaison`                    | Une collection par environnement (staging/prod).      |
| `config.EMBED_DIM`           | `384`                             | Doit matcher le modèle d'embedding effectif.          |

## Lint

```bash
helm lint ./infrastructure/helm/retrieval
```
