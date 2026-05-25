"""FastAPI app. Route /health pour K8s, /v1/chat/turn pour invoquer la boucle.

L'API publique côté edge-api passera par gRPC (cf. grpc_server.py). Cette
surface HTTP est utile pour les smoke tests + outils dev (curl, httpie).
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from ai_core.config import get_settings
from ai_core.logging import get_logger
from ai_core.orchestrator import Orchestrator, TurnInput

logger = get_logger(__name__)


class TurnRequest(BaseModel):
    workspace_id: str
    user_id: str
    chat_id: str
    message: str
    model: str | None = None


class TurnResponse(BaseModel):
    chat_id: str
    text: str
    finish_reason: str


def create_app(orchestrator: Orchestrator | None = None) -> FastAPI:
    """Factory FastAPI. Injection explicite de l'orchestrator pour les tests."""

    orchestrator = orchestrator or Orchestrator()
    settings = get_settings()

    app = FastAPI(
        title='ai-core',
        version='0.0.1',
        docs_url='/docs' if settings.NODE_ENV != 'production' else None,
    )

    @app.get('/health')
    async def health() -> dict[str, str]:
        return {'status': 'ok', 'service': settings.OTEL_SERVICE_NAME}

    @app.post('/v1/chat/turn', response_model=TurnResponse)
    async def turn(req: TurnRequest) -> TurnResponse:
        out = await orchestrator.turn(
            TurnInput(
                workspace_id=req.workspace_id,
                user_id=req.user_id,
                chat_id=req.chat_id,
                message=req.message,
                model=req.model,
            )
        )
        return TurnResponse(
            chat_id=out.chat_id,
            text=out.text,
            finish_reason=out.finish_reason,
        )

    return app
