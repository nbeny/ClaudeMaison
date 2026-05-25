# `infrastructure/`

Tout ce qui n'est pas code applicatif : conteneurisation, orchestration, IaC, observabilité.

## Sous-dossiers prévus

| Dossier       | Contenu                                                                                     | Statut  |
| ------------- | ------------------------------------------------------------------------------------------- | ------- |
| `docker/`     | Dockerfiles communs, `docker-compose.dev.yml` (Postgres, Redis, Qdrant, MinIO, NATS locaux) | à créer |
| `kubernetes/` | Helm charts par service, valeurs par environnement                                          | à créer |
| `terraform/`  | provisioning Scaleway/OVH (clusters K8s, bases managées, buckets, DNS)                      | à créer |
| `monitoring/` | dashboards Grafana, règles Prometheus, configs Loki/Tempo                                   | à créer |

## Cibles d'hébergement

Voir [Partie XII §12.1](../docs/architecture/2026-05-24-architecture-souveraine.md#121-hébergement-eu) du doc d'architecture.

**Aucune ressource AWS / GCP / Azure** dans les modules Terraform.
