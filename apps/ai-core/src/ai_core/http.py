"""FastAPI app. Route /health pour K8s, /v1/chat/turn pour invoquer la boucle.

L'API publique côté edge-api passera par gRPC (cf. grpc_server.py). Cette
surface HTTP est utile pour les smoke tests + outils dev (curl, httpie).
"""

from __future__ import annotations

from fastapi import BackgroundTasks, FastAPI
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


class _HistoryMessage(BaseModel):
    role: str
    content: str


class _TurnStreamBody(BaseModel):
    conversationId: str
    workspaceId: str
    userId: str
    messageId: str
    model: str | None = None
    history: list[_HistoryMessage]


def create_app(orchestrator: Orchestrator | None = None) -> FastAPI:
    """Factory FastAPI. Injection explicite de l'orchestrator pour les tests."""

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
        orch = orchestrator
        if orch is None:
            orch = Orchestrator()
        out = await orch.turn(
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

    @app.post('/v1/chat/turn/stream', status_code=202)
    async def turn_stream(body: _TurnStreamBody, bg: BackgroundTasks) -> dict[str, str]:
        # Dernier message user = pivot ; en Phase 1 on n'utilise pas l'history
        # complet (passé directement dans messages[]).
        user_msg = next(
            (m.content for m in reversed(body.history) if m.role == 'user'),
            '',
        )
        orch = orchestrator
        if orch is None:
            orch = Orchestrator()  # avec publisher None → erreur ; cas testé avec stub
        bg.add_task(
            orch.turn_stream,
            TurnInput(
                workspace_id=body.workspaceId,
                user_id=body.userId,
                chat_id=body.conversationId,
                message=user_msg,
                model=body.model,
            ),
            message_id=body.messageId,
        )
        return {'status': 'accepted'}

    return app
