# `infrastructure/`

Tout ce qui n'est pas code applicatif : conteneurisation, orchestration, IaC, observabilité.

## Sous-dossiers

| Dossier          | Contenu                                                                                | Statut   |
| ---------------- | -------------------------------------------------------------------------------------- | -------- |
| `db/`            | Schéma Atlas déclaratif (Postgres), migrations versionnées                             | en place |
| `docker/`        | Dockerfiles communs, `docker-compose.dev.yml` (stack locale complète : profil `apps`)  | en place |
| `helm/`          | 1 chart par binaire (7 binaires) + README transverse                                   | en place |
| `argocd/`        | AppProject + ApplicationSet (1 Application par binaire) + values overrides             | en place |
| `observability/` | OTel Collector, dashboards Grafana, règles Prometheus                                  | partiel  |
| `terraform/`     | provisioning Scaleway/OVH (clusters K8s, bases managées, buckets, DNS)                 | à créer  |

## Cibles d'hébergement

Voir [Partie XII §12.1](../docs/architecture/2026-05-24-architecture-souveraine.md#121-hébergement-eu) du doc d'architecture.

**Aucune ressource AWS / GCP / Azure** dans les modules Terraform.
