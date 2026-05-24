# ADR-0011 — GitHub avec runners CI auto-hébergés EU

## Statut

Accepté — 2026-05-24

## Contexte

ADR-0002 impose la souveraineté EU dans le chemin de requête de production. Le **code source** n'est pas dans ce chemin de requête, mais les **artefacts de build** (images Docker, SBOM, signatures) le sont, et la CI manipule potentiellement des secrets de production.

Trois options :
1. GitHub avec runners hosted GitHub (US).
2. GitHub avec runners auto-hébergés EU.
3. Forgejo + Woodpecker entièrement auto-hébergés.

## Décision

**GitHub** pour l'hébergement du code source, avec **runners GitHub Actions auto-hébergés** sur instances Scaleway/OVH dans l'UE.

Justification :
- Le source n'est pas la partie sensible — les données utilisateurs et l'inférence le sont.
- DX GitHub > Forgejo pour les développeurs (PRs, revue, Codespaces, marketplace).
- Runners auto-hébergés garantissent que les artefacts (images, secrets de build, SBOM) ne quittent jamais l'infra EU.

Migration vers Forgejo réservée comme option future si un client public-sector l'exige.

## Alternatives considérées

- **GitHub avec runners hosted** — rejeté : artefacts construits sur infra US.
- **Forgejo + Woodpecker self-hosted** — option valide mais coût ops + perte de DX non justifiés au stade actuel.
- **GitLab CE self-hosted** — équivalent fonctionnel à Forgejo, plus lourd à opérer.

## Conséquences

**Positives** :
- DX moderne pour les développeurs.
- Artefacts produits et stockés exclusivement en EU (Harbor self-hosted).
- Décision réversible : migration vers Forgejo possible si besoin (le code Git est portable).

**Négatives** :
- Dépendance à GitHub pour le code source (acceptée explicitement).
- Coût supplémentaire des runners auto-hébergés vs runners GitHub gratuits.

**Engagements** :
- Aucun secret de production stocké dans GitHub Secrets — tout via Vault interpellé par les runners.
- Mirror Git automatique vers un Forgejo passif (DR + portabilité prouvée).
- Documenter la procédure de migration Forgejo dans un runbook.
