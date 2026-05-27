# Roadmap d'amélioration — ClaudeMaison

> **Date** : 2026-05-27
> **Statut** : design approuvé, en attente de revue utilisateur avant `writing-plans`
> **Horizon** : 12 mois (M1 → M12)
> **Auteur unique** : solo
> **Référence architecture** : [`docs/architecture/2026-05-24-architecture-souveraine.md`](../../architecture/2026-05-24-architecture-souveraine.md)

## 1. Contexte & objectif

Le repo est greenfield. À ce jour (M0) :

- **`edge-api` mature** : auth (signup/signin/OIDC), billing (plans, quotas, usage_events, gRPC), observabilité (OTel SDK + Collector + Prom + Tempo + Grafana), tests d'intégration testcontainers, supply-chain CI (Trivy + Syft + Cosign), Helm chart, Argo CD ApplicationSet.
- **6 autres binaires scaffoldés mais vides** : `realtime`, `ai-core`, `inference-router`, `retrieval`, `tools`, `workers`.
- **Front absent** : `apps/web` (Next.js) et `apps/mobile` (React Native) pas démarrés.
- **Infra prod absente** : Argo CD pointe sur rien de réel, pas de Vault prod, pas de cluster K8s déployé.

**Objectif de cette roadmap** : à M12, une **bêta publique étroite** est ouverte avec les 3 capacités produit suivantes :

1. **Chat LLM** streamé end-to-end, self-hosted (souverain), avec fallback Mistral API (souverain EU).
2. **RAG hybride** : upload de docs, ingestion async, réponses citant les sources.
3. **Tool-calling** : agent exécutant code Python / shell dans un sandbox isolé.

Le tout déployé sur cluster K8s EU réel (Scaleway/OVH), avec mTLS, secrets Vault, backups testés.

## 2. Contraintes acceptées

| Contrainte                          | Implication                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Solo sur 12 mois**                | Phases séquentielles, max 2 chantiers en parallèle, YAGNI ruthless.                                          |
| **GPU local AMD RX 6900 XT 16 Go**  | vLLM (ADR-0006) abandonné ; `llama.cpp server` + Mistral API fallback. Plafond modèle ~14B Q4 local.         |
| **Workstation Kali Linux**          | Distro pentest assumée pour le dev. Friction ROCm possible (paquets parfois en retard vs Ubuntu).            |
| **Souveraineté non-négociable**     | Pas de cloud US dans le chemin de requête. Mistral API (FR) seul fallback externe autorisé.                  |
| **Pas de pré-training maison**      | ADR-0001 reste valide. On consomme des modèles open-weights existants.                                       |

## 3. Approche choisie — Walking skeleton itératif

Approche retenue parmi 3 options (binaire-par-binaire complet / chemin chaud d'abord / walking skeleton itératif) :

> Le squelette complet (les 7 binaires + front) fait passer un chat end-to-end **dès M3**, même si chaque binaire est minimal. Ensuite, on creuse par tranches transverses (RAG, puis tools, puis durcissement). Chaque binaire est revisité plusieurs fois mais la chaîne reste démontrable en permanence.

**Pourquoi** : feedback réel possible tôt, réduit le risque de découvrir des mismatchs d'architecture en fin de période, livre une capacité visible à chaque phase, solo-friendly.

**Trade-off accepté** : chaque binaire est touché 2-3 fois sur 12 mois (refactor inhérent au modèle).

## 4. Phases

### 4.1 Phase 1 — Walking skeleton chat (M1 → M3)

**Capacité livrée** : un message tapé dans un browser arrive jusqu'à un LLM local et stream token-par-token dans l'UI.

**Travail par binaire :**

- **`inference-router`** : spec + impl. Façade OpenAI-compatible (`/v1/chat/completions` streaming). Backends : `llama.cpp server` (local, ROCm) + Mistral API (fallback). Routage initial trivial par taille de modèle.
- **`ai-core`** : spec + impl. Orchestrator minimal, stratégie `simple-chat`. Pas de mémoire, pas d'outils, pas de RAG.
- **`realtime`** : spec + impl. SSE `/v1/conversations/:id/stream`, flux tokens via NATS (pub/sub par `conversation_id`).
- **`edge-api`** : ajout module `conversations` (table `conversations`, `messages`), mutations GraphQL `sendMessage`, publication NATS.
- **`apps/web`** : bootstrap Next.js 15, auth Keycloak (OIDC déjà en place), pages `/login` `/chat/[id]`, composant `ChatStream` consommant SSE.
- **`workers`, `retrieval`, `tools`** : restent scaffold.

**ADRs :**

- **ADR-0006** réécrit : vLLM → llama.cpp server (raison : AMD RDNA2).
- **ADR-0013** nouveau : stratégie de routage `inference-router`.

**Compose dev** : service `llama-cpp-server` ajouté, modèle par défaut Qwen 2.5 7B Instruct Q4_K_M (~5 Go VRAM).

**Critères de fin de Phase 1 :**

- [ ] `pnpm dev` → je tape, ça stream
- [ ] Mistral fallback testé (var d'env qui force le routage)
- [ ] Specs écrites pour `inference-router`, `ai-core`, `realtime`
- [ ] ADR-0006 réécrit, ADR-0013 publié
- [ ] CI verte sur les 4 binaires touchés
- [ ] Aucun secret en clair, dev marche sans Vault

**Risques :**

- **ROCm setup sur Kali** : 1 jour à ~1 semaine selon backports. Mitigation : valider en semaine 1, isolément.
- **Tokenizers/templates de chat divergents** entre llama.cpp et Mistral API : `inference-router` normalise. Risque mineur.

**Métriques de succès P1 :**

- Latence first-token < 1.5s en local llama.cpp 7B
- Uptime des binaires en compose > 99% sur une session d'usage de 4h

### 4.2 Phase 2 — Tranche RAG (M4 → M6)

**Capacité livrée** : upload d'un document, question dessus, réponse citant les passages.

**Travail par binaire :**

- **`retrieval`** : spec + impl. Endpoints `/embed`, `/search`, `/index`. Qdrant collection par workspace, embeddings `bge-large-fr` (CPU OK pour MVP), pas de reranking Jour-1.
- **`workers`** : spec + impl. Worker NATS consommant la queue `ingestion`. Pipeline : MinIO → extraction (`pypdf` pour PDF, Markdown brut) → chunking token-based ~500 tokens overlap → embed → index. Status d'ingestion persisté Postgres (`documents`, `document_chunks`).
- **`edge-api`** : module `documents`. `POST /v1/uploads/init` (URL pré-signée MinIO), `POST /v1/documents/finalize` (enregistrement + publish NATS). GraphQL `Document`, `documents(workspaceId)`. Quota MinIO via `billing`.
- **`ai-core`** : stratégie `rag-chat`. Query `retrieval/search` → injection chunks dans le prompt système avec format de citation strict (`[1]`, `[2]`...). Émet canal SSE séparé `source` via `realtime`.
- **`realtime`** : event types SSE typés (`token`, `source`, `done`). Pas de refonte.
- **`inference-router`** : pas de changement structurel.

**Front :** drag-and-drop upload, liste docs avec statut d'ingestion, panneau "Sources" en chat, clic `[1]` scrolle au passage.

**MinIO** ajouté au compose dev, bucket `documents-<workspace_id>`, lifecycle de purge temporaire.

**Critères de fin de Phase 2 :**

- [ ] Upload PDF → ingestion async → recherche → citation correcte dans la réponse
- [ ] Sources cliquables dans l'UI
- [ ] Specs écrites pour `retrieval`, `workers`
- [ ] Quota documents/storage respecté côté `billing`
- [ ] Test e2e ingestion d'un fixture + vérification réponse citante
- [ ] CI verte sur les 5 binaires touchés

**Risques :**

- **Qualité du chunking naïf** : médiocre possible. Acceptable MVP, à itérer post-bêta.
- **bge-large-fr CPU** : 100-200ms par embedding. OK pour ingestion async + 1 embedding par question.
- **PDFs scannés** non gérés (OCR hors scope). Limitation documentée.

**Métriques de succès P2 :**

- Ingestion PDF 50 pages < 60s
- Précision citation > 70% sur set fixture de 20 questions

### 4.3 Phase 3 — Tranche outils & mémoire (M7 → M9)

**Capacité livrée** : l'agent exécute du code Python / shell sandboxé et utilise le résultat dans sa réponse.

**Travail par binaire :**

- **`tools`** : spec + impl. `/v1/execute` reçoit `{tool_name, args, workspace_id}`, alloue un microVM Firecracker éphémère. Tools Jour-3 : `python_exec` (stdlib + numpy/pandas), `shell_exec` (bash restreint), `read_file`/`write_file` (workspace FS isolé). Quota CPU/RAM/timeout par appel. Artifacts vers MinIO sous `tool-artifacts/<exec_id>/`.
- **`ai-core`** : stratégie `tool-calling-chat`, boucle ReAct simple. JSON structuré strict, max 5 tours, fallback "je n'arrive pas à terminer". Stream événements `tool_call` / `tool_result` via `realtime`.
- **Mémoire 4 couches — implémentation P3 :**
  - **L1 Conversation** : déjà là (`messages`).
  - **L2 Court terme résumé** : toutes les N tours, `ai-core` génère un résumé du tour précédent (cheap LLM call) → `conversation_summaries`. Injecté à la place des vieux messages.
  - **L3 Long terme par workspace** : extraction de "faits saillants" en fin de conv (Jour-1 manuel, P4 auto). Stockés `workspace_memories`, indexés via embeddings Qdrant. Récupérés au début d'une nouvelle conv.
  - **L4 Profil utilisateur** : skip jusqu'à post-bêta. YAGNI.
- **`edge-api`** : extension quota pour `tool_execution`. Table `tool_executions` pour l'audit.
- **`realtime`, `inference-router`, `retrieval`, `workers`** : pas de changement structurel, nouveaux types d'events SSE pour le front.

**Front** : rendu `tool_call` (bloc replié/déplié avec output), panneau "Mémoires" du workspace (voir/éditer/supprimer), Markdown enrichi + Shiki pour outputs code.

**ADRs :**

- **ADR-0014** nouveau : sandboxing & catalogue tools.
- **ADR-0015** nouveau : architecture mémoire 4 couches.

**Compose dev** : runtime Firecracker (natif sur Linux, OK sur Kali).

**Critères de fin de Phase 3 :**

- [ ] "Calcule la moyenne de cette colonne" sur un PDF → ingère (P2) → exécute Python → répond avec le bon chiffre
- [ ] Quotas tool execution respectés (test : `while true` tué au timeout)
- [ ] L1 + L2 + L3 mémoire fonctionnelles, L3 alimentée manuellement
- [ ] Spec écrite pour `tools`, ADR-0014 et ADR-0015 publiés
- [ ] CI : test e2e tool-calling avec fixture déterministe

**Risques :**

- **Boucle ReAct qui diverge** sur LLM 7B : limite stricte 5 tours, format JSON validé, fallback explicite.
- **Tools surface d'attaque** : sandboxing Firecracker + quotas stricts + audit log obligatoire avant prod.

**Métriques de succès P3 :**

- Tool call déterministe sur 90% des prompts test
- Boucle ReAct converge en ≤3 tours sur 80% des cas

### 4.4 Phase 4 — Durcissement & alpha publique (M10 → M12)

**Capacité livrée** : ce qui marchait en local tourne sur un cluster K8s EU réel, est utilisé par 3-5 testeurs alpha puis ouvert en bêta publique étroite (≥10 utilisateurs).

**Travail infra (le gros morceau) :**

- **Cluster K8s réel** : Scaleway Kapsule ou OVH Managed Kubernetes (3 nodes + 1 node GPU optionnel pour `inference-router` cloud). Provisioning console au début, IaC fin P4 si motivé.
- **Vault prod** : chart officiel, storage Raft 3 nodes ou Postgres backend. Vault Agent injector → secrets en tmpfs. Migration `JWT_SIGNING_KEY`, `BILLING_GRPC_TOKEN`, `MISTRAL_API_KEY`, etc. depuis env vars.
- **Argo CD branché sur le vrai cluster** : ApplicationSet déjà écrit, juste à pointer le `destination`. Auto-bump image déjà en place.
- **mTLS inter-binaires via Linkerd** (choix par défaut : simple à opérer solo, mTLS auto, latence minime). ADR-0016 nouveau.
- **Backups/DR** : Postgres `pg_dump` snapshot quotidien → MinIO chiffré (30 j rétention). Qdrant snapshot natif. MinIO réplication cross-region si budget. Test de restore documenté dans `docs/runbooks/restore.md`. ADR-0017 nouveau.
- **Keycloak prod** : instance dédiée TLS, realm `claudemaison`, SMTP reset, MFA TOTP activé.

**Travail binaires (durcissement, pas de features lourdes) :**

- **Tests cross-binaires** : workflow GH Actions boot le compose + Playwright scénario complet (signup → upload doc → chat tool call → vérification). Tourne à chaque PR.
- **Mémoire L3 extraction auto** : LLM "memory extractor" en async via `workers` à fin de conv. L4 toujours skip.
- **Rate-limiting distribué** : passage du rate-limit Fastify in-process → Redis (déjà déployé). Limites par plan billing.
- **Audit log** : actions sensibles (auth, tool exec, doc upload, memory edit) → table `audit_events` append-only, export S3-compatible chiffré.

**Travail front :**

- **Mobile React Native (Expo)** : version minimale (login, liste convs, chat streamé). Pas d'upload doc mobile Jour-1, pas de tool UI riche. Build iOS + Android via EAS, distribué TestFlight / Play Internal.
- **Polish web** : design pass, dark mode, raccourcis clavier, command palette, accessibilité base (axe-core CI).
- **Landing page** : `/` publique, présentation projet, formulaire "demander accès bêta" → email.

**Alpha (M10 → M11) :**

- 3-5 testeurs choisis (proches techniques). Comptes provisionnés à la main.
- Feedback hebdo dans `docs/runbooks/alpha-feedback.md`. Pas de SLA. Disclaimer "alpha".

**Bêta publique étroite (M12) :**

- Liste d'attente sur landing, ouverture par lots de ~20. Quotas free serrés (10 messages/jour, 100 Mo). Pas de paiement Jour-1. Badge "bêta" partout.

**ADRs :**

- **ADR-0016** : mTLS via Linkerd.
- **ADR-0017** : politique backups/DR.

**Critères de fin de Phase 4 (= fin de roadmap) :**

- [ ] `https://app.claudemaison.<tld>` accessible publiquement, TLS valide
- [ ] Tous les secrets viennent de Vault, aucun env clair en prod
- [ ] mTLS actif entre les 7 binaires (Linkerd dashboard le prouve)
- [ ] Restore depuis backup testé et documenté
- [ ] Mobile builds disponibles en TestFlight + Play Internal
- [ ] 3+ testeurs alpha actifs pendant ≥4 semaines, feedback consolidé
- [ ] Bêta publique ouverte avec ≥10 utilisateurs externes
- [ ] Runbooks écrits : incident, restore, scale-up GPU, rotation secrets
- [ ] Doc d'architecture mise à jour (delta vs étoile-polaire de M0)

**Risques :**

- **Budget cloud EU** : 300-800 €/mois selon dimensionnement. À acter avant M10. Mitigation : démarrer minimal, scale up à l'usage.
- **Charge solo** : phase la plus chargée. Si retard, arbitrage = garder web + alpha, couper mobile RN (décale en M13+).
- **Compliance RGPD** : données réelles = obligations. MVP = politique de confidentialité claire, pas de feature DPO complète.

**Métriques de succès P4 :**

- SLO 99% disponibilité sur 30 j
- Latence p95 first-token < 3s en prod
- 0 incident sécu critique

## 5. Travail transverse (étalé sur les 4 phases)

### 5.1 Specs par binaire

Écrites au moment où on creuse chaque binaire, pas en lot :

| Spec                          | Phase de rédaction |
| ----------------------------- | ------------------ |
| `inference-router/design.md`  | P1                 |
| `ai-core/design.md`           | P1                 |
| `realtime/design.md`          | P1                 |
| `retrieval/design.md`         | P2                 |
| `workers/design.md`           | P2                 |
| `tools/design.md`             | P3                 |

`edge-api/design.md` reçoit un delta à chaque phase qui touche le module gateway.

### 5.2 ADRs à publier ou réviser

| ADR                                                   | Phase       |
| ----------------------------------------------------- | ----------- |
| ADR-0006 réécrit : vLLM → llama.cpp                   | Début P1    |
| ADR-0013 nouveau : stratégie de routage inference-router | Début P1 |
| ADR-0014 nouveau : sandboxing & catalogue tools       | Début P3    |
| ADR-0015 nouveau : architecture mémoire 4 couches     | Début P3    |
| ADR-0016 nouveau : mTLS via Linkerd                   | Début P4    |
| ADR-0017 nouveau : politique backups/DR               | Début P4    |

### 5.3 Front-end

Progresse en parallèle, jamais en phase isolée. Chaque phase backend a son delta UI documenté dans la phase correspondante.

### 5.4 Dépendances

- **Renovate** déjà configuré, bumps en continu, pas de chantier dédié.
- **Migration Kali Linux + réinstallation toolchain** (Node 22, Python 3.13, Docker, pnpm, uv, ROCm) : ~1 semaine **avant** M1.

## 6. Hors-périmètre Jour-1 (YAGNI explicite)

| Sujet                                              | Pourquoi reporté                                            |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Paiements / Stripe-like / facturation réelle       | Pas de revenus en bêta. `billing` calcule, ne facture pas.  |
| Mémoire L4 (profil utilisateur cross-conv)         | Complexité élevée, gain incertain Jour-1                    |
| Multi-tenancy SaaS strict (chiffrement par tenant) | Bêta = mono-instance, isolation logique suffit              |
| Reranker neural pour le RAG                        | Naïf top-k OK MVP, à itérer post-bêta                       |
| Voice mode (WS) — ADR-0008                         | Hors scope MVP, ADR reste mais implémentation post-bêta     |
| Vision (InternVL)                                  | 16 Go VRAM trop tight, post-bêta avec GPU plus gros         |
| Fine-tuning / training maison                      | ADR-0001 : pas de pré-training                              |
| Marketplace de tools / plugins tiers               | Surface d'attaque énorme, post-bêta                         |
| Apps desktop (Tauri/Electron)                      | Web PWA + mobile RN couvrent les besoins MVP                |
| Compliance SOC2/ISO27001                           | Post-revenus, post-équipe                                   |

## 7. Métriques de succès agrégées

### Techniques (objectives)

| Métrique                                          | Cible        | Phase de mesure |
| ------------------------------------------------- | ------------ | --------------- |
| Latence first-token local 7B                      | < 1.5s       | P1              |
| Uptime compose session 4h                         | > 99%        | P1              |
| Ingestion PDF 50 pages                            | < 60s        | P2              |
| Précision citation RAG (set fixture 20 Q)         | > 70%        | P2              |
| Tool call déterministe                            | 90% prompts  | P3              |
| Boucle ReAct converge en ≤3 tours                 | 80% cas      | P3              |
| SLO disponibilité prod 30 j                       | 99%          | P4              |
| Latence p95 first-token prod                      | < 3s         | P4              |
| Incidents sécu critiques                          | 0            | P4              |

### Produit (subjectives mais trackées)

- ≥ **3 testeurs alpha** disent "je l'utiliserais à la place de ChatGPT/Claude pour [cas d'usage spécifique]"
- ≥ **1 cas d'usage différenciant** émergé (un truc que les commerciaux US ne font pas bien)
- Bêta publique : ≥ **10 inscrits** qui reviennent 2+ fois

## 8. Circuit-breakers globaux

| Risque                                  | Trigger                              | Action                                                  |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| Retard cumulé > 4 semaines à fin P2     | Date réelle fin P2 vs M6             | Couper mobile RN de P4, garder web seul                 |
| Coût cloud EU > 800 €/mois en P4        | Facture Scaleway/OVH                 | Scale down à 1 node, GPU à la demande                   |
| Modèle local pas assez bon              | Tests utilisateurs P2-P3 unanimes    | Bascule Mistral API par défaut, llama.cpp en fallback   |
| Burnout solo                            | Auto-évaluation hebdo                | Phase 4 décale ; rythme cible 30h/sem max               |

## 9. Prochaines étapes (post-approbation de ce design)

1. **Revue utilisateur** de ce document.
2. **Invocation `writing-plans`** pour produire un plan d'implémentation détaillé phase par phase (avec découpe en tickets pour la P1 d'abord).
3. **Pré-requis hors plan** : migration Kali Linux + toolchain (1 semaine).
4. **Démarrage P1** : commencer par valider ROCm + llama.cpp en isolation, puis enchaîner `inference-router`.
