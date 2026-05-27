# Architecture Decision Records (ADRs)

Une décision structurante = un ADR. Format inspiré de [Michael Nygard, 2011](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Règles

- **Numéros séquentiels** : `0001`, `0002`, … Jamais réutilisés.
- **Immuables** : un ADR accepté n'est pas modifié sur le fond. S'il devient obsolète, on en écrit un nouveau qui marque l'ancien comme `Remplacé par ADR-XXXX`.
- **Courts** : un ADR fait typiquement une page. Le contexte long va dans le document d'architecture.
- **Datés** : la date de la décision est dans le frontmatter de statut.

## Création

```bash
cp docs/adr/template.md docs/adr/00NN-titre-kebab.md
```

## Index

| #                                                   | Titre                                              | Statut  |
| --------------------------------------------------- | -------------------------------------------------- | ------- |
| [0001](0001-pas-d-entrainement-modele-fondation.md) | Pas d'entraînement de modèle de fondation          | Accepté |
| [0002](0002-souverainete-eu-hybride.md)             | Souveraineté EU-hybride                            | Accepté |
| [0003](0003-monorepo-turborepo-pnpm.md)             | Monorepo Turborepo + pnpm                          | Accepté |
| [0004](0004-15-services-logiques-6-binaires.md)     | 15 services logiques, 6 binaires Jour-1            | Accepté |
| [0005](0005-graphql-grpc-nats.md)                   | GraphQL côté client, gRPC interne, NATS asynchrone | Accepté |
| [0006](0006-runtime-llm.md)                         | llama.cpp + fallback Mistral API                   | Accepté |
| [0007](0007-bge-large-fr-embeddings.md)             | bge-large-fr pour les embeddings                   | Accepté |
| [0008](0008-sse-defaut-ws-vocal.md)                 | SSE par défaut, WebSocket pour vocal/collab        | Accepté |
| [0009](0009-argo-cd-helm.md)                        | Argo CD + Helm pour le déploiement                 | Accepté |
| [0010](0010-firecracker-sandboxing.md)              | Firecracker pour le sandboxing des outils          | Accepté |
| [0011](0011-github-runners-auto-heberges.md)        | GitHub avec runners auto-hébergés EU               | Accepté |
| [0012](0012-vault-cosign-trivy-sbom.md)             | Vault + Cosign + Trivy + SBOM                      | Accepté |
