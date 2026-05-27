"""FastAPI app. Route /health pour K8s, /v1/chat/turn pour invoquer la boucle.

L'API publique côté edge-api passera par gRPC (cf. grpc_server.py). Cette
surface HTTP est utile pour les smoke tests + outils dev (curl, httpie).
"""

from __future__ import annotations

from fastapi import BackgroundTasks, FastAPI, HTTPException
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


async def _run_stream(
    orch: Orchestrator,
    inp: TurnInput,
    message_id: str,
) -> None:
    try:
        await orch.turn_stream(inp, message_id=message_id)
    except Exception as exc:
        logger.exception(
            'turn_stream.failed',
            conversation_id=inp.chat_id,
            message_id=message_id,
            error=str(exc),
        )
        # On essaie d'émettre un event d'erreur côté NATS pour ne pas laisser
        # le client SSE pendre. Si même ça échoue (NATS down), on a au moins le log.
        try:
            await orch.emit_error(
                conversation_id=inp.chat_id,
                message_id=message_id,
                reason='internal_error',
            )
        except Exception:
            logger.exception('turn_stream.error_emit_failed')


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
            raise HTTPException(status_code=503, detail='orchestrator not configured')
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
        orch = orchestrator
        if orch is None:
            raise HTTPException(status_code=503, detail='orchestrator not configured')
        # Dernier message user = pivot ; en Phase 1 on n'utilise pas l'history
        # complet (passé directement dans messages[]).
        user_msg = next(
            (m.content for m in reversed(body.history) if m.role == 'user'),
            None,
        )
        if not user_msg:
            raise HTTPException(
                status_code=422,
                detail='history must contain at least one user message',
            )
        bg.add_task(
            _run_stream,
            orch,
            TurnInput(
                workspace_id=body.workspaceId,
                user_id=body.userId,
                chat_id=body.conversationId,
                message=user_msg,
                model=body.model,
            ),
            body.messageId,
        )
        return {'status': 'accepted'}

    return app
