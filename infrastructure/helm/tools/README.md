# Chart Helm — tools

Chart de déploiement du binaire `tools` : registre d'outils exécutables
(echo, http_get builtins ; sandboxed exec à venir) exposé en gRPC pur.

## Installation

```bash
helm install tools ./infrastructure/helm/tools \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Spécificités

- **gRPC pur**, pas de HTTP. Pas d'ingress, pas de service HTTP.
- **Probes TCP socket** Day-1 : l'image ne ship pas encore `grpc_health_probe`
  ni service Health gRPC. La TCP socket vérifie que le listener accepte les
  connexions ; ça ne détecte pas un servicer qui répond UNAVAILABLE.
  Day-2 : ajouter `grpc_health_probe` dans le Dockerfile + endpoint Health et
  override les probes en `exec`.
- **`http_get` builtin** : tape Internet par défaut. En prod, activer
  `networkPolicy.enabled=true` et restreindre l'egress à une whitelist.

## Pré-requis

| Ressource                  | Pourquoi                                                   |
| -------------------------- | ---------------------------------------------------------- |
| Secret `tools-secrets`     | Tokens pour outils tiers (Day-2).                          |
| metrics-server             | Si `autoscaling.enabled=true`                              |

## Variables critiques

| Clé                       | Défaut       | Remarque                                                          |
| ------------------------- | ------------ | ----------------------------------------------------------------- |
| `image.tag`               | `""`         | Setter via CI.                                                    |
| `config.TOOL_TIMEOUT_S`   | `"10"`       | Timeout dur de chaque exécution d'outil.                          |
| `config.HTTP_MAX_BYTES`   | `"1048576"`  | Limite réponse `http_get` (anti-DoS).                             |
| `networkPolicy.enabled`   | `false`      | **Activer en prod** pour contraindre l'egress de `http_get`.      |

## Lint

```bash
helm lint ./infrastructure/helm/tools
```
