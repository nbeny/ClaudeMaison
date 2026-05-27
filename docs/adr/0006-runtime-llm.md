# ADR-0006 — Runtime LLM auto-hébergé : llama.cpp server + fallback Mistral API

**Statut :** Accepted (révisé 2026-05-27)
**Supersedes :** version vLLM-first du 2026-05-24

## Contexte

Le projet exige une inférence souveraine (pas de cloud US dans le chemin de requête). Le hardware de dev est un AMD Radeon RX 6900 XT 16 Go (RDNA2 / gfx1030). vLLM cible CUDA en priorité ; son support ROCm est expérimental sur RDNA2 et casse à chaque release majeure. Les modèles > 22B en Q4 dépassent la VRAM disponible.

## Décision

1. **Backend principal local :** `llama.cpp` (serveur OpenAI-compatible, binaire `server`), compilé avec `LLAMA_HIPBLAS=1` pour ROCm. Quantization GGUF Q4_K_M par défaut.
2. **Fallback EU souverain :** Mistral API (Mistral AI, FR) pour les modèles > 14B ou en cas d'indisponibilité locale. Mistral est dans l'UE → respecte la contrainte non-négociable de souveraineté.
3. **Routing :** assuré par `inference-router` (cf. ADR-0013). Chaque entrée du catalogue déclare `primary` (llama.cpp) et `fallback` (Mistral) optionnels.
4. **Modèles cibles MVP :**
   - `qwen2.5-coder-7b-q4` (llama.cpp local) — chat code par défaut
   - `mistral-7b-instruct-q4` (llama.cpp local) — chat général
   - `mistral-large-latest` (Mistral API) — tâches lourdes / fallback

## Conséquences

- **Positives :** stack stable sur Kali Linux, souveraineté préservée (Mistral = EU), pas de dépendance CUDA.
- **Négatives :** llama.cpp single-process (pas de batch concurrent natif comme vLLM) → throughput limité. Acceptable pour solo/MVP.
- **Migration vers vLLM-ROCm** rouverte si AMD stabilise gfx1030 ou si on bascule sur un GPU CDNA/RDNA3 supporté.
