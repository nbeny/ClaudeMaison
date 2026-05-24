# ADR-0002 — Souveraineté EU-hybride

## Statut

Accepté — 2026-05-24

## Contexte

Cible de marché : utilisateurs et entreprises européens soumis au RGPD et à l'AI Act, secteurs régulés (santé, finance, défense, public). Les services hébergés aux États-Unis sont exposés au *CLOUD Act* et au *FISA §702*, ce qui pose des problèmes contractuels et réglementaires majeurs pour beaucoup de prospects EU.

## Décision

**Aucune dépendance d'exécution sur un cloud américain dans le chemin de requête de production.** Modèle « hybride pragmatique » :

- **Plan d'inférence** : GPUs en colocation ou loués chez opérateur européen (Scaleway, OVHcloud).
- **Plan de contrôle** : Kubernetes hébergé EU (Scaleway Kapsule ou équivalent).
- **Bases & stockage** : Postgres / Redis / Qdrant / MinIO opérés EU.
- **Fallback IA** : Mistral API (FR) acceptable quand les GPUs internes saturent. **Claude API, OpenAI API : exclus.**
- **CDN, DNS, email** : fournisseurs européens uniquement.
- **GitHub** : toléré pour l'hébergement du code source (non sensible), avec **runners CI auto-hébergés EU** pour que les artefacts (images, SBOM) ne quittent pas l'infra EU.

## Alternatives considérées

- **Souveraineté maximaliste** (on-premises strict, pas de fournisseur tiers) — rejetée : ops trop lourdes pour une petite équipe.
- **EU-sovereign complet sans GitHub** (Forgejo + Woodpecker self-hosted) — réservée comme option future si un client public-sector l'exige.
- **Cloud US pragmatique** — rejetée : invalide la proposition de valeur principale.

## Conséquences

**Positives** :
- Argument commercial clair pour le marché EU régulé.
- Conformité RGPD et AI Act simplifiée.
- Coûts d'inférence souvent inférieurs aux hyperscalers US (pas d'egress, GPU loués moins chers).

**Négatives** :
- Disponibilité GPU H100 plus rare en EU qu'aux US.
- Pas d'accès aux modèles frontière fermés (Claude, GPT-4) → on dépend de l'écosystème ouvert.
- Quelques services SaaS courants (Datadog, Vercel, Auth0) sont exclus → on les remplace par leurs équivalents auto-hébergés.

**Engagements** :
- Revue annuelle des fournisseurs pour vérifier qu'aucun n'est passé sous juridiction US.
- Procédures de réversibilité par fournisseur documentées.
