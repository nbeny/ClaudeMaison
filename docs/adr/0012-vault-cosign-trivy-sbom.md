# ADR-0012 — Vault + Cosign + Trivy + SBOM pour la supply chain

## Statut

Accepté — 2026-05-24

## Contexte

Une plateforme IA souveraine traitant données utilisateur et exécutant du code potentiellement adverse doit avoir une chaîne d'approvisionnement minimum sérieuse dès le Jour-1. Le coût marginal d'ajouter ces outils plus tard est élevé (rétrofit, perte de traçabilité historique).

## Décision

Quatre piliers de la supply chain :

| Outil                                  | Rôle                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **HashiCorp Vault** (OSS, self-hosted) | Stockage et distribution de tous les secrets, rotation automatique des credentials DB et clés de signature JWT                            |
| **Cosign** (Sigstore)                  | Signature de toute image Docker publiée sur Harbor ; vérification de signature obligatoire à l'admission Kubernetes via policy-controller |
| **Trivy**                              | Scan de vulnérabilités sur images Docker et dépendances en CI ; gate sur sévérité HIGH+ pour merge                                        |
| **Syft → SBOM**                        | Génération automatique du SBOM (format CycloneDX) pour chaque image, attaché à Harbor                                                     |

Plus, en complément :

- **Gitleaks** : scan des secrets dans le code en CI (pre-commit + pre-push).
- **Semgrep** : SAST en CI sur règles communes + règles custom prompt-injection.
- **Renovate** : PRs automatiques pour les mises à jour de dépendances de sécurité.

## Alternatives considérées

- **AWS Secrets Manager / Google Secret Manager** — exclus (cloud US).
- **Notary v2** au lieu de Cosign — Cosign plus simple, écosystème Sigstore mieux établi.
- **Snyk / WhiteSource hostés** — exclus (services US et coût). Trivy est OSS et suffit.

## Conséquences

**Positives** :

- Conformité plus simple (RGPD audit, futurs requirements de cyber-assurance, AI Act).
- Détection précoce des CVE et secrets fuités.
- Vérification de signature empêche le déploiement d'images non signées.

**Négatives** :

- Vault est un composant critique à opérer (HA, backups, sealing/unsealing).
- Le SBOM ajoute du temps en CI.

**Engagements** :

- Runbook Vault (initialisation, unseal, rotation root token, restore) écrit avant la mise en production.
- Politique : aucun secret en clair dans le code ni dans `*.env` commités. CI le vérifie via Gitleaks.
- Revue trimestrielle des CVE non corrigées au-delà de 30 jours.
