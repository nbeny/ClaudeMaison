# ClaudeMaison

Plateforme assistant IA **auto-hébergée**, **souveraine EU**.

> Statut : amorçage. Aucun code applicatif livré pour l'instant — seules l'architecture de référence et les décisions structurantes sont en place.

## Où commencer

1. **Document d'architecture** (étoile-polaire, 18 parties) : [`docs/architecture/2026-05-24-architecture-souveraine.md`](docs/architecture/2026-05-24-architecture-souveraine.md)
2. **Décisions structurantes** (ADRs) : [`docs/adr/`](docs/adr/)
3. **Suivi des décisions à venir** : ouvrir une PR avec un nouvel ADR.

## Structure du dépôt

```
ClaudeMaison/
├── apps/              # services applicatifs et clients (à venir)
├── packages/          # code partagé (à venir)
├── infrastructure/    # Docker, Kubernetes, Terraform, dashboards (à venir)
├── docs/
│   ├── architecture/  # vision étoile-polaire
│   ├── adr/           # Architecture Decision Records
│   ├── specs/         # specs détaillées par service
│   └── runbooks/      # procédures opérationnelles
└── scripts/           # outillage développeur
```

## Outillage requis

| Outil     | Version | Source                            |
| --------- | ------- | --------------------------------- |
| Node.js   | 22.11+  | `.nvmrc`                          |
| pnpm      | 9.15+   | `package.json` (`packageManager`) |
| Python    | 3.12    | `.python-version`                 |
| Turborepo | 2.3+    | `devDependencies`                 |

Installation initiale (à exécuter une fois les premières apps créées) :

```bash
corepack enable
pnpm install
```

## Souveraineté

Contrainte non négociable : **pas de cloud américain dans le chemin de requête de production**. Voir [ADR-0002](docs/adr/0002-souverainete-eu-hybride.md).

## Licence

À définir.
