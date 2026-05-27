# inference-router — Design

## Routage avec fallback

Source de vérité : ADR-0013 (`docs/adr/0013-inference-routing.md`).

### Configuration

Format préféré (Phase 1) — `MODEL_BACKENDS` env string :

```
mistral-7b-instruct-q4=http://llama-cpp-1:8080,http://llama-cpp-2:8080;mistral-large-latest=mistral:https://api.mistral.ai|env:MISTRAL_API_KEY
```

- Séparateur de modèles : `;`
- Séparateur d'entrées : `=` (model=backends)
- Séparateur de backends : `,`
- Préfixe optionnel `<provider>:` (par défaut `llama-cpp`)
- Suffixe optionnel `|env:<VAR>` pour injecter un Bearer token

### Algorithme

1. Backends groupés par `priority` (0 = primaire). Round-robin **dans** chaque groupe.
2. Sur échec (`ConnectError`, `ReadTimeout`, ou HTTP ≥ 500) → essayer le prochain backend du même groupe ; si tous épuisés → groupe suivant.
3. En streaming : aucun fallback en cours de stream (le client a déjà reçu des tokens). Couper avec un event `error`.
4. Toutes les tentatives échouent → HTTP 503 avec body `{"error": "all_backends_failed", "attempts": N}`.
