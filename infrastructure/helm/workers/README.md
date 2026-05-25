# Chart Helm — workers

Chart de déploiement du binaire `workers` : consommateur Arq (Redis) qui
traite les jobs asynchrones (indexation différée, fan-out, etc.).

## Installation

```bash
helm install workers ./infrastructure/helm/workers \
  --namespace claudemaison \
  --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

## Particularités

- **Pas de service, pas d'ingress** : Arq consomme Redis en pull, aucun
  endpoint exposé.
- **Pas de HPA CPU** : la métrique pertinente est la profondeur de la queue
  Redis. Day-2 : intégrer KEDA (`ScaledObject` redis-list trigger) ; en
  attendant, scaling manuel via `replicaCount`.
- **Concurrence totale** = `replicaCount` × `config.WORKER_MAX_JOBS`. Tuner
  selon la pression acceptable sur retrieval/Qdrant.
- **Liveness exec** : `pgrep -f workers.main`. Détecte le crash du process,
  pas un worker zombie qui ne progresse plus. Day-2 : exposer un /healthz
  interne pour ça.

## Pré-requis

| Ressource                  | Pourquoi                                                        |
| -------------------------- | --------------------------------------------------------------- |
| Secret `workers-secrets`   | REDIS_PASSWORD si auth, tokens APIs externes utilisés en jobs.  |
| Redis joignable            | Queue Arq : `config.REDIS_URL`.                                 |
| retrieval déployé          | `RETRIEVAL_URL` pour les jobs d'indexation.                     |

## Variables critiques

| Clé                       | Défaut                                          | Remarque                                              |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `image.tag`               | `""`                                            | Setter via CI.                                        |
| `replicaCount`            | `2`                                             | Scale horizontal Day-1 (KEDA Day-2).                  |
| `config.WORKER_MAX_JOBS`  | `"10"`                                          | Jobs concurrents par pod (event-loop asyncio).        |
| `config.REDIS_URL`        | `redis://redis-master.data.svc:6379`            | Queue Arq.                                            |
| `config.RETRIEVAL_URL`    | `http://retrieval.claudemaison.svc:4100`        | API d'indexation côté retrieval.                      |

## Lint

```bash
helm lint ./infrastructure/helm/workers
```
