import type { FastifyInstance } from 'fastify';
import type { TokenVerifier } from '../auth';
import type { SseHub, SseEntry } from './hub';

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
    let claims: { sub: string };
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
      reply.raw.write(':keepalive\n\n');
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      deps.hub.remove(entry);
    });
  });
}
