# `infrastructure/argocd/`

GitOps scaffold pour ClaudeMaison via [Argo CD](https://argo-cd.readthedocs.io/).
Un `ApplicationSet` génère une `Application` par binaire ; chaque
Application consomme un chart Helm dans `infrastructure/helm/` avec un
override `values/<binaire>.yaml` versionné ici.

## Layout

```
infrastructure/argocd/
├── appproject.yaml          # AppProject "claudemaison" (scope, RBAC)
├── applicationset.yaml      # ApplicationSet (list generator × 7 binaires)
└── values/
    ├── edge-api.yaml
    ├── realtime.yaml
    ├── ai-core.yaml
    ├── retrieval.yaml
    ├── inference-router.yaml
    ├── tools.yaml
    └── workers.yaml
```

## Bootstrap

Une fois Argo CD installé dans le cluster (`namespace: argocd`) :

```bash
kubectl apply -f infrastructure/argocd/appproject.yaml
kubectl apply -f infrastructure/argocd/applicationset.yaml
```

L'ApplicationSet crée alors automatiquement 7 `Application`. Vérifier :

```bash
kubectl -n argocd get applications.argoproj.io
argocd app list --project claudemaison
```

## Workflow CI → GitOps

1. PR mergé sur `main` → workflow `supply-chain.yml` build + signe l'image.
2. Workflow d'image bump (Day-2 : à câbler) ouvre une PR qui modifie
   `values/<binaire>.yaml` : `image.tag: sha-<commit>`.
3. PR de bump mergée → Argo CD détecte le drift sous ~3 minutes et
   synchronise. `selfHeal: true` garantit que le cluster colle à Git.

En attendant le bumper automatique, mettre à jour le tag à la main dans
le fichier values puis push sur `main`.

## Sécurité / scoping

L'`AppProject` restreint :
- **sourceRepos** : uniquement ce repo (impossible de pointer ailleurs).
- **destinations** : un seul cluster (`kubernetes.default.svc`) +
  namespace `claudemaison`.
- **clusterResourceWhitelist** : vide (aucune CRD/ClusterRole autorisée
  sans modifier le projet — signal explicite).
- **namespaceResourceWhitelist** : liste explicite (Deployment, Service,
  ConfigMap, ServiceAccount, HPA, PDB, Ingress, NetworkPolicy,
  ServiceMonitor).

## Multi-environnement (Day-2)

Pour staging + prod, dupliquer ce pattern :
- Un `AppProject` par cluster cible (`claudemaison-staging`, `claudemaison-prod`).
- Un `ApplicationSet` par env qui pointe sur des `values/<env>/<binaire>.yaml`.
- Argo CD Image Updater pour bump auto via annotations (alternative au
  bumper CI custom).

Ou, plus simple : 1 ApplicationSet avec generator `matrix` qui combine
`[edge-api, realtime, …] × [staging, prod]` et préfixe les noms
d'Application.

## Secrets

Aucun Secret n'est dans Git. Les charts référencent un `existingSecret`
(`<binaire>-secrets`) attendu dans le namespace, provisionné via
ExternalSecrets/Vault out-of-band. Sans le Secret, le pod reste en
`CreateContainerConfigError` (signal explicite plutôt qu'une fuite
silencieuse de valeurs factices).

## Sync policy

L'ApplicationSet active `automated.prune: true` + `selfHeal: true` Day-1
(approprié pour dev/staging). Pour la prod, considérer :
- `prune: false` : sync manuelle après revue PR.
- `selfHeal: false` : autoriser temporairement des modifs manuelles
  (hotfix d'urgence).

`ignoreDifferences` couvre `/spec/replicas` du Deployment (sinon Argo
boucle avec HPA + selfHeal).
