# ADR-0013 — Stratégie de routage `inference-router`

**Statut :** Accepted (2026-05-27)

## Contexte

`inference-router` doit pouvoir : (1) servir plusieurs backends OpenAI-compatibles pour un même modèle logique (load-balancing), (2) basculer automatiquement vers un fallback distant (Mistral API) si le backend primaire échoue, (3) propager le streaming OpenAI sans tampon intermédiaire.

## Décision

1. **Configuration par modèle** : chaque modèle logique a une liste de backends, chacun avec un `priority` (entier ; `0` = priorité la plus haute) :
   ````yaml
   # MODEL_BACKENDS_YAML (monté en config map)
   mistral-7b-instruct-q4:
     - url: http://llama-cpp-1:8080      # primaire
       priority: 0
     - url: http://llama-cpp-2:8080      # peer du primaire (round-robin)
       priority: 0
     - url: https://api.mistral.ai       # fallback si tous les locaux KO
       priority: 1
       api_key_env: MISTRAL_API_KEY
   ````

2. **Algorithme** : round-robin parmi les backends de plus haute priorité (`priority` le plus bas). Si tous échouent (timeout ou 5xx) → descendre d'un cran. Si la dernière priorité échoue → 503 au client.

3. **Détection d'échec** : `httpx.ReadTimeout`, `httpx.ConnectError`, ou réponse HTTP ≥ 500. Les 4xx remontent telles quelles (erreur client).

4. **Streaming** : on proxy le flux SSE de l'amont vers l'aval token-par-token sans bufferisation. Si l'amont stream et tombe en milieu de génération, on n'essaie pas de basculer le fallback (le client a déjà reçu des tokens partiels) — on coupe avec un événement `error`.

## Conséquences

- Pour le MVP Phase 1, on garde le format `MODEL_BACKENDS` env string (déjà existant) mais on ajoute `MODEL_BACKENDS_YAML` (fichier monté) qui prend le pas s'il existe. Migration progressive.
- Le routing reste synchrone par requête. Pas de pool persistant côté router : chaque chat completion ouvre une connexion httpx → suffisant à l'échelle solo.
