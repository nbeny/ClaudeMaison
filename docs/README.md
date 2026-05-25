# `docs/`

Documentation vivante du projet.

| Dossier         | Contenu                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `architecture/` | document d'architecture étoile-polaire (vision à 18 mois)                     |
| `adr/`          | Architecture Decision Records — une décision structurante = un ADR            |
| `specs/`        | specs détaillées par service (à venir, créées au démarrage de chaque service) |
| `runbooks/`     | procédures ops (incidents, déploiement, restore, rotation de secrets)         |

## Conventions

- **Architecture** : 1 seul document de référence à un moment donné. Une nouvelle version = nouveau fichier daté ; l'ancien est conservé pour traçabilité.
- **ADR** : numérotés `NNNN-titre-kebab.md`, ne sont jamais supprimés. Si une décision change, on crée un nouvel ADR qui marque l'ancien comme "Remplacé par".
- **Spec** : une spec par service, dans `specs/<service>/`. Une spec décrit l'API, les contrats, les invariants, les modes de défaillance.
- **Runbook** : une procédure = un fichier. Écrits pour être lus à 3h du matin.
