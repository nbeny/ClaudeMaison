# Observabilité — stack dev locale

Stack opt-in pour visualiser les métriques et traces émises par les binaires
ClaudeMaison via OpenTelemetry. Tout est self-hosted, EU-compatible, Apache 2.0,
zéro phone-home : aucun cloud US ni télémétrie sortante non-désirée.

## Composants

| Composant        | Rôle                                                    | Port hôte                                          |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `otel-collector` | Reçoit OTLP gRPC/HTTP des binaires, route vers backends | `4317` (gRPC), `4318` (HTTP), `8889` (Prom expose) |
| `prometheus`     | Stockage et requêtage des métriques                     | `9090`                                             |
| `tempo`          | Stockage et requêtage des traces distribuées            | `3200`                                             |
| `grafana`        | UI : dashboards + explore                               | `3001` (3000 pris par edge-api)                    |

Pipeline :

```
edge-api/ai-core/... ──(OTLP)──> otel-collector ──> prometheus  (scrape :8889)
                                                └─> tempo       (OTLP gRPC)
                                                grafana <── prometheus + tempo
```

## Démarrage

```bash
# Depuis le repo root :
docker compose -f infrastructure/docker/docker-compose.dev.yml --profile obs up -d
```

Puis dans le `.env` d'un binaire (par exemple `apps/edge-api/.env`) :

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Sans cette variable, le SDK reste no-op (cf. `apps/edge-api/src/telemetry.ts`).

## Vérifier que ça marche

1. `http://localhost:3001` → Grafana, dashboard **ClaudeMaison / edge-api — Vue d'ensemble**.
2. Générer du trafic : `curl -X POST http://localhost:3000/auth/signin -d ...` (cf. README edge-api).
3. Dans Grafana → Explore → datasource Prometheus :
   - `auth_attempts_total` doit apparaître après ~30s (push toutes les 15s + scrape 15s).
4. Explore → datasource Tempo → tab **Search** : les traces des requêtes GraphQL/HTTP doivent remonter.

## Conventions de nommage

Les métriques custom suivent le pattern `<domaine>_<sujet>_<unité>` :

| Métrique                              | Type    | Labels            | Origine          |
| ------------------------------------- | ------- | ----------------- | ---------------- |
| `auth_attempts_total`                 | counter | `kind`, `result`  | `AuthService`    |
| `billing_quota_check_total`           | counter | `kind`, `allowed` | `QuotaService`   |
| `billing_usage_events_recorded_total` | counter | `result`          | `BillingService` |

Les métriques auto-instrumentées par OTel (HTTP server, GraphQL resolver
duration, ioredis, pg) gardent leur nom semconv standard.

## Configuration

- `otel-collector/config.yaml` : pipelines, batching, memory limiter.
- `prometheus/prometheus.yml` : scrape interval, jobs.
- `tempo/tempo.yaml` : monolithic mode, storage local, rétention 24h.
- `grafana/provisioning/datasources/` : Prom + Tempo provisionnés.
- `grafana/provisioning/dashboards/` : provisioner pointe vers `grafana/dashboards/`.
- `grafana/dashboards/*.json` : dashboards versionnés (éditables UI, modifs reflétées si re-export).

## Production

Cette stack reste pertinente en prod, avec quelques ajustements :

- Tempo en mode microservices (distributor / ingester / querier / compactor) + storage S3/MinIO.
- Prometheus → Mimir si on dépasse ~1M de séries actives.
- Grafana derrière Keycloak (SSO), `GF_AUTH_ANONYMOUS_ENABLED=false`.
- Collector déployé en DaemonSet (1 par node) + Deployment central.
- Rétention métriques 30j+, traces 7j (échantillonnage tail-based si volume).

Tout cela est porté en Helm dans `infrastructure/helm/observability/` (à venir).
