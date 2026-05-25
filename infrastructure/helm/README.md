# `infrastructure/helm/`

Charts Helm pour les 7 binaires de la plateforme. Un chart par binaire,
chacun versionné indépendamment (champ `version` du Chart.yaml). Le
`appVersion` suit le tag de l'image Docker, injecté par CI au déploiement.

## Charts

| Chart                | Binaire             | Ports                | Spécificités                                     |
| -------------------- | ------------------- | -------------------- | ------------------------------------------------ |
| `edge-api/`          | edge-api            | HTTP 3000, gRPC 5001 | Façade GraphQL/REST + gRPC interne               |
| `realtime/`          | realtime            | HTTP 3100 (+ WS)     | Grace period long pour drain WS                  |
| `ai-core/`           | ai-core             | HTTP 4000, gRPC 5002 | Orchestrateur, pull inference-router & retrieval |
| `retrieval/`         | retrieval           | HTTP 4100            | RAG ; pas d'ingress par défaut                   |
| `inference-router/`  | inference-router    | HTTP 4200            | Proxy LLM ; `MODEL_BACKENDS` obligatoire en prod |
| `tools/`             | tools               | gRPC 5005            | Pas de HTTP ; probes TCP socket Day-1            |
| `workers/`           | workers             | (aucun)              | Arq Redis ; pas de service ; pas de HPA Day-1    |

## Lint & rendu local

```bash
helm lint ./infrastructure/helm/<chart>
helm template smoke ./infrastructure/helm/<chart> | yq -r .

# Tout linter d'un coup :
for c in edge-api realtime ai-core retrieval inference-router tools workers; do
  helm lint ./infrastructure/helm/$c
done
```

## Installation

Chaque chart est autonome (pas de subchart) :

```bash
helm install <release> ./infrastructure/helm/<chart> \
  --namespace claudemaison --create-namespace \
  --set image.tag=sha-<commit> \
  -f values-prod.yaml
```

Production : un seul `Application` Argo CD par binaire pointe vers ces
charts + un `values-prod.yaml` versionné séparément (dans
`infrastructure/argocd/` à venir).

## Secrets

Aucun chart ne crée de `Secret`. Tous référencent un `existingSecret`
(`<binaire>-secrets`) provisionné en amont via ExternalSecrets/Vault. Si
le secret n'existe pas, le pod reste en `CreateContainerConfigError`
(signal explicite plutôt que valeurs factices silencieuses).

## NetworkPolicy

Désactivée par défaut (requiert un CNI compatible). À activer en prod en
override `networkPolicy.enabled=true` et compléter les selectors egress
selon les namespaces réels (Postgres, Redis, OTel Collector, etc.).

## Probes

- **HTTP** binaires : liveness/readiness sur `/health` (Terminus côté Node,
  endpoint FastAPI côté Python).
- **gRPC** binaires (tools) : TCP socket Day-1. Day-2 : `grpc_health_probe`
  binaire dans l'image + service Health gRPC, override probes en `exec`.
- **workers** : pas de service donc pas de readiness. Liveness via
  `pgrep -f workers.main` pour détecter le crash du process.

## ADR liés

- ADR-0009 : 7 binaires comme unité de déploiement.
- ADR-0012 : supply chain par binaire (Trivy + SBOM + Cosign keyless).
