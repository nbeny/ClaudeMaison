# ADR-0010 — Firecracker pour le sandboxing des outils

## Statut

Accepté — 2026-05-24

## Contexte

Le `tool-service` exécute du code et des shells **fournis ou influencés par des LLMs**, donc potentiellement par des utilisateurs malveillants via prompt injection. L'isolation doit être forte (process / namespace / cgroup ne suffisent pas), démarrer en millisecondes (pas de cold start utilisateur visible), et tourner sur Linux x86_64 standard.

## Décision

**Firecracker microVMs** pour toute exécution d'outil sensible (shell, code-execution Python/Node, browser headless).

Chaque invocation d'outil :

1. Spawn d'une microVM dédiée à partir d'un snapshot pré-chauffé.
2. Système de fichiers : rootfs read-only + volume scratch éphémère.
3. Réseau : par défaut **désactivé** ; activation par allowlist au cas par cas (ex. tool `web_search` a accès à des moteurs whitelistés uniquement).
4. Limites cgroup : CPU, mémoire, durée d'exécution (timeout dur).
5. VM détruite après chaque invocation.

## Alternatives considérées

- **Conteneurs Docker / runc** — rejeté : surface kernel partagée, escape exploits historiquement réguliers.
- **gVisor** — bonne option intermédiaire, moins isolant que Firecracker.
- **Kata Containers** — équivalent à Firecracker, plus orienté workloads Kubernetes long-running.
- **WASM (wasmtime)** — convient pour code-execution simple, insuffisant pour outils complexes (browser, FFI).

## Conséquences

**Positives** :

- Isolation au niveau VM (KVM).
- Démarrage en ~125 ms.
- Utilisé en prod par AWS Lambda — éprouvé.

**Négatives** :

- Linux x86_64 / ARM64 uniquement (acceptable, c'est notre cible serveur).
- Gestion d'images de microVM = nouvelle compétence à acquérir.
- Le `tool-service` doit tourner sur des nœuds K8s avec accès `/dev/kvm` (nodes bare-metal ou instances _.metal_).

**Engagements** :

- Pool de microVMs pré-chauffées pour amortir le démarrage perçu.
- Audit régulier des allowlists réseau par tool.
- Logs immuables (WORM) de chaque invocation pour traçabilité.
