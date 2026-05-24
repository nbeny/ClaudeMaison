# ADR-0001 — Pas d'entraînement de modèle de fondation

## Statut

Accepté — 2026-05-24

## Contexte

Construire un assistant IA compétitif. Deux stratégies extrêmes :

1. Pré-entraîner un modèle de fondation propriétaire.
2. Construire sur des modèles à poids ouverts existants.

Le pré-entraînement d'un modèle de classe Llama 70B coûte des dizaines de millions d'euros en compute et nécessite une équipe de chercheurs séniors. Pour une petite équipe à financement limité, c'est hors de portée — et l'écart entre les meilleurs modèles ouverts (Llama 3.3, DeepSeek-R1, Qwen 2.5) et les modèles fermés frontière se resserre rapidement.

## Décision

On **n'entraîne aucun modèle de fondation**. La plateforme est construite sur des modèles à poids ouverts servis via vLLM sur nos propres GPUs. Le fine-tuning ciblé (LoRA d'adaptation domaine, rerankers spécifiques, embeddings fine-tunés FR) reste autorisé quand il offre un gain mesurable.

## Alternatives considérées

- **Pré-entraînement complet** — rejeté : coût capitalistique disqualifiant.
- **Continued pretraining** d'un modèle ouvert — possible à terme, mais hors champ pour le Jour-1. À reconsidérer si différenciation domaine forte.

## Conséquences

**Positives** :
- Capital concentré sur l'orchestration, la mémoire, le RAG, l'UX — la vraie différenciation.
- Bénéfice automatique des progrès de l'écosystème ouvert.
- Time-to-market drastiquement réduit.

**Négatives** :
- Dépendance à la disponibilité continue de modèles ouverts de qualité.
- Pas d'avantage compétitif sur "l'intelligence brute" du modèle.

**Engagements** :
- Veille active sur les nouvelles sorties (revue trimestrielle du catalogue).
- Maintenir la capacité d'intégrer un nouveau modèle rapidement (cf. routeur d'inférence, [Partie VII](../architecture/2026-05-24-architecture-souveraine.md#partie-vii--routeur-dinférence)).
