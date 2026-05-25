# Chart Helm — edge-api

Chart de déploiement du binaire `edge-api` (façade GraphQL/REST/gRPC).

## Installation

```bash
helm install edge-api ./infrastructure/helm/edge-api \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Pré-requis

| Ressource                      | Pourquoi                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Secret `edge-api-secrets`      | DATABASE_URL, REDIS_URL, JWT_PRIVATE_KEY, OIDC_CLIENT_SECRET, etc.           |
| metrics-server                 | Si `autoscaling.enabled=true` (HPA v2 CPU)                                   |
| Prometheus Operator            | Si `serviceMonitor.enabled=true`                                             |
| NetworkPolicy controller (CNI) | Si `networkPolicy.enabled=true` (Calico, Cilium)                             |
| OTel Collector                 | Doit être joignable à `OTEL_EXPORTER_OTLP_ENDPOINT` (defaults : svc cluster) |

## Variables critiques

| Clé                       | Défaut             | Remarque                                                                                                       |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `image.tag`               | `""`               | À setter via CI (digest signé Cosign). Sans valeur, fallback `Chart.appVersion`.                               |
| `existingSecret`          | `edge-api-secrets` | Le chart NE crée PAS ce secret. Externalisé via ExternalSecrets/Vault.                                         |
| `config.OIDC_ENABLED`     | `"false"`          | Activer en prod après config realm Keycloak.                                                                   |
| `autoscaling.maxReplicas` | `10`               | Day-1 prudent. Ajuster avec le throughput réel.                                                                |
| `networkPolicy.enabled`   | `false`            | Activer en prod ; à compléter par les selectors des composants amont (Postgres, Redis, etc.) dans values-prod. |

## Render local sans cluster

```bash
helm template edge-api ./infrastructure/helm/edge-api \
  --set image.tag=dev \
  | yq -r .
```

## Lint

```bash
helm lint ./infrastructure/helm/edge-api
```

## Production (à venir)

- Argo CD application qui pointe sur ce chart + values-prod.yaml dans `infrastructure/argocd/`.
- `values-staging.yaml` pour le cluster pré-prod.
- ExternalSecret manifest dans le namespace (out-of-chart par séparation des préoccupations).
