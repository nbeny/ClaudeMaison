import type { FastifyInstance } from 'fastify';
import type { TokenClaims, TokenVerifier } from '../auth';
import type { SseHub, SseEntry } from './hub';

const SSE_HEARTBEAT_MS = 15_000;

export interface ConversationAcl {
  canRead(userId: string, conversationId: string): Promise<boolean>;
}

export function registerSseRoutes(
  app: FastifyInstance,
  deps: { verifier: TokenVerifier; hub: SseHub; acl: ConversationAcl },
): void {
  app.get<{
    Params: { conversationId: string };
    Querystring: { token?: string };
  }>('/sse/v1/conversations/:conversationId/stream', async (req, reply) => {
    const token = req.query.token;
    if (!token) {
      reply.code(401).send({ error: 'missing token' });
      return;
    }
    let claims: TokenClaims;
    try {
      claims = await deps.verifier.verify(token);
    } catch {
      reply.code(401).send({ error: 'invalid token' });
      return;
    }
    if (!(await deps.acl.canRead(claims.sub, req.params.conversationId))) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }

    // IMPORTANT : reply.hijack() doit rester APRÈS toutes les early-returns
    // (401/403). Une fois hijack appelé, reply.send(...) est ignoré et les
    // erreurs HTTP ne partiraient plus au client.
    // Hijack the response so Fastify doesn't call reply.send() / end() after
    // the handler returns, which would close the SSE stream prematurely.
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately so the client's fetch() resolves without waiting
    // for the first data chunk.
    reply.raw.flushHeaders();

    const entry: SseEntry = {
      userId: claims.sub,
      channel: req.params.conversationId,
      reply,
    };
    deps.hub.add(entry);

    const heartbeat = setInterval(() => {
      try {
        if (reply.raw.destroyed) {
          clearInterval(heartbeat);
          deps.hub.remove(entry);
          return;
        }
        reply.raw.write(':keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
        deps.hub.remove(entry);
      }
    }, SSE_HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      deps.hub.remove(entry);
    });
  });
}
