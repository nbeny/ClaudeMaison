"""Squelette de la boucle d'orchestration.

À ce stade : un stub qui montre la surface de l'API. La vraie boucle (recall
mémoire → plan → tool calls → réponse) sera implémentée incrémentalement
sur des branches dédiées.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ai_core.logging import get_logger

logger = get_logger(__name__)


@dataclass(slots=True)
class TurnInput:
    workspace_id: str
    user_id: str
    chat_id: str
    message: str
    model: str | None = None


@dataclass(slots=True)
class TurnOutput:
    chat_id: str
    text: str
    finish_reason: Literal['stop', 'length', 'tool_call', 'error'] = 'stop'
    tool_calls: list[dict[str, object]] = field(default_factory=list)


class Orchestrator:
    """Boucle de raisonnement principale.

    Au Jour-1 c'est un pass-through vers le LLM. Au fur et à mesure qu'on
    ajoutera memory-service.recall(), planner agent, critic, on enrichira
    sans casser la signature `turn()`.
    """

    async def turn(self, input: TurnInput) -> TurnOutput:
        logger.info(
            'orchestrator turn',
            workspace_id=input.workspace_id,
            chat_id=input.chat_id,
            model=input.model,
        )
        # TODO: appel inference-router (OpenAI-compatible) + memory recall.
        # Ce stub renvoie un écho pour valider le câblage HTTP/gRPC bout en bout.
        return TurnOutput(
            chat_id=input.chat_id,
            text=f'echo: {input.message}',
            finish_reason='stop',
        )
