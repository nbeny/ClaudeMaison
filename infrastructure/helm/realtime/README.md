# Chart Helm — realtime

Chart de déploiement du binaire `realtime` (gateway WebSocket pour streaming
tokens et présence).

## Installation

```bash
helm install realtime ./infrastructure/helm/realtime \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Pré-requis

| Ressource                      | Pourquoi                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Secret `realtime-secrets`      | JWT_PUBLIC_KEY (verify), REDIS_PASSWORD si auth, etc.                          |
| Redis (pub/sub)                | Inter-pods : un pod publie, n'importe quel autre transmet à sa WS attachée.    |
| Ingress avec WS                | Annotations `proxy-read-timeout` / `proxy-http-version: 1.1` côté nginx.       |
| metrics-server                 | Si `autoscaling.enabled=true`                                                  |

## Spécificités WebSocket

- `terminationGracePeriodSeconds: 60` : laisse les connexions WS se fermer
  proprement quand un pod drain (rolling update, scale-down).
- `scaleDown.stabilizationWindowSeconds: 600` : on évite le churn de pods qui
  portent des connexions actives.
- Anti-affinity hostname : prévient la perte simultanée de tous les replicas
  si un node disparaît (les WS sont stateful jusqu'à reconnect côté client).

## Variables critiques

| Clé                                | Défaut                                  | Remarque                                                  |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------- |
| `image.tag`                        | `""`                                    | À setter via CI (digest signé Cosign).                    |
| `config.REDIS_URL`                 | `redis://redis-master.data.svc:6379`    | Pub/sub inter-pods ; required.                            |
| `ingress.annotations`              | Annotations nginx WS-friendly           | Adapter si LB ≠ nginx (Traefik, HAProxy : autres clés).   |
| `terminationGracePeriodSeconds`    | `60`                                    | Ne pas réduire sans réduire aussi le timeout WS client.   |

## Lint

```bash
helm lint ./infrastructure/helm/realtime
```
