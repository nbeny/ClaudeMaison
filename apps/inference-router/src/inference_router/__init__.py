"""inference-router — proxy OpenAI-compatible.

Jour-1 : routing par nom de modèle vers un backend, round-robin entre
réplicas du même modèle. Pas de quota, pas de cache, pas de fallback.
Voir docs/architecture §3.4.
"""

__version__ = '0.0.1'
