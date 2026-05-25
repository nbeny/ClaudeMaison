"""workers — Arq + Redis. Jobs asynchrones du Jour-1.

Volontairement minimal : un seul handler `ingest_document` qui appelle
retrieval pour indexer un texte. La suite (transcription, OCR, etc.)
arrivera quand on aura des sources concrètes.
"""

__version__ = '0.0.1'
