# ADR-0006 — vLLM comme runtime d'inférence unique

## Statut

Accepté — 2026-05-24

## Contexte

Plusieurs runtimes d'inférence existent (vLLM, TGI de Hugging Face, llama.cpp, TensorRT-LLM, SGLang, MLC-LLM). Opérer plusieurs runtimes en parallèle multiplie la surface ops et complique le routeur.

## Décision

**vLLM** comme runtime d'inférence par défaut pour tous les LLM et embeddings GPU servis sur nos propres GPUs.

Raisons :
- **PagedAttention** : KV-cache géré finement, supporte le partage de cache entre requêtes d'une même conversation.
- **Batching dynamique** : excellent débit en multi-tenant.
- **Speculative decoding** intégré.
- Support natif des principales architectures (Llama, Qwen, DeepSeek, Mistral, Gemma).
- Compatible OpenAI API → simplifie l'intégration côté routeur.

## Alternatives considérées

- **TGI (Hugging Face)** — bon, mais débit légèrement inférieur en multi-tenant lourd.
- **TensorRT-LLM** — performance excellente mais opérationnellement plus complexe (recompilation par modèle, dépendance forte NVIDIA).
- **SGLang** — prometteur, à réévaluer dans 6 mois.

## Conséquences

**Positives** :
- Un seul runtime à apprendre, monitorer, mettre à jour.
- Excellent débit dès le Jour-1.

**Négatives** :
- Risque d'engagement excessif si vLLM stagne ; le routeur d'inférence isole heureusement les services applicatifs de ce choix.

**Engagements** :
- Le routeur d'inférence ne suppose pas l'usage de vLLM ; il parle l'API OpenAI-compatible. Toute substitution future (TGI, SGLang) est mécanique.
- Pinning strict de la version vLLM par environnement, mise à jour mensuelle accompagnée d'un benchmark.
