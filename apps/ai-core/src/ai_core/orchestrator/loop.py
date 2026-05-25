"""Boucle d'orchestration — Jour-1.

À ce stade : passthrough vers inference-router avec un system prompt fixe.
La vraie boucle (recall mémoire → plan → tool calls → réponse) sera
implémentée incrémentalement sur des branches dédiées sans casser la
signature `turn()`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ai_core.config import get_settings
from ai_core.inference import ChatMessage, InferenceClient, InferenceError
from ai_core.logging import get_logger

logger = get_logger(__name__)

_SYSTEM_PROMPT = (
    'Tu es ClaudeMaison, un assistant IA souverain hébergé en Europe. '
    'Réponds de manière concise et précise. Si tu ne sais pas, dis-le.'
)


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

    Au Jour-1 c'est un pass-through vers inference-router. Quand on ajoutera
    memory recall, planner, critic, on enrichira sans changer la surface.

    Le client d'inférence est injecté pour permettre le mock en tests.
    """

    def __init__(self, inference: InferenceClient | None = None) -> None:
        self._inference = inference or InferenceClient()

    async def turn(self, input: TurnInput) -> TurnOutput:
        model = input.model or get_settings().LLM_DEFAULT_MODEL
        logger.info(
            'orchestrator.turn',
            workspace_id=input.workspace_id,
            chat_id=input.chat_id,
            model=model,
        )

        messages = [
            ChatMessage(role='system', content=_SYSTEM_PROMPT),
            ChatMessage(role='user', content=input.message),
        ]

        try:
            completion = await self._inference.chat(model=model, messages=messages)
        except InferenceError as exc:
            logger.warning('orchestrator.inference_error', error=str(exc), status=exc.status)
            return TurnOutput(
                chat_id=input.chat_id,
                text='Désolé, le modèle est indisponible.',
                finish_reason='error',
            )

        return TurnOutput(
            chat_id=input.chat_id,
            text=completion.text,
            finish_reason=completion.finish_reason,
        )

    async def aclose(self) -> None:
        await self._inference.aclose()
