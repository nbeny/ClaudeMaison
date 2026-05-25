# ADR-0007 — bge-large-fr pour les embeddings

## Statut

Accepté — 2026-05-24

## Contexte

Choix du modèle d'embeddings pour le RAG et la mémoire vectorielle. Cible utilisateurs principalement francophones (au démarrage), avec besoin de qualité solide en multilingue. Contraintes : poids ouverts, license commerciale OK, taille raisonnable (servable sur L40S avec autres workloads).

Modèles considérés :

- **bge-large-fr** (fine-tune FR de BAAI bge-large) — 1024 dims, optimisé FR.
- **multilingual-e5-large** — bonne baseline multilingue mais moins fort en FR.
- **jina-embeddings-v3** — bon multilingue mais license plus restrictive selon usage.
- **OpenAI text-embedding-3** — exclu (cloud US).
- **mistral-embed** — license API uniquement, pas auto-hébergeable.

## Décision

**`BAAI/bge-large-fr`** comme modèle d'embedding par défaut (1024 dimensions, distance cosine).

Pour les usages non-FR critiques (documents internationaux d'un client), basculer ponctuellement vers `multilingual-e5-large` via la route `EMBEDDING` du routeur.

Reranking via **`BAAI/bge-reranker-v2-m3`** (cross-encoder) sur le top-50 fusionné.

## Alternatives considérées

Voir liste ci-dessus.

## Conséquences

**Positives** :

- Qualité FR supérieure aux baselines multilingues.
- License Apache-2.0.
- Communauté active.

**Négatives** :

- Performance dégradée sur langues sous-représentées (à mesurer si on cible un nouveau marché).
- Migration vers un autre embedder = réindexation complète de Qdrant (coûteux).

**Engagements** :

- Versionnage strict du modèle d'embedding par collection Qdrant.
- Procédure de migration documentée (double-écriture pendant transition).
- Évaluation trimestrielle vs nouveautés du leaderboard MTEB-fr.
