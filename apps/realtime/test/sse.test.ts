import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SseHub } from '../src/sse/hub';
import { registerSseRoutes } from '../src/sse/routes';

// Faux vérificateur de token qui accepte tout.
const verifier = {
  async verify(_token: string) {
    return { sub: 'user-1' };
  },
};

// Faux ACL : autorise tout.
const acl = { canRead: async () => true };

describe('SSE endpoint', () => {
  let app: FastifyInstance;
  let hub: SseHub;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    hub = new SseHub();
    registerSseRoutes(app, { verifier: verifier as never, hub, acl });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('streams payloads broadcast through the hub', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/sse/v1/conversations/c1/stream?token=ok`;

    const received: string[] = [];
    const ctrl = new AbortController();
    const respPromise = fetch(url, { signal: ctrl.signal });
    const resp = await respPromise;
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    // Démarrer la lecture en parallèle.
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const readUntil = (async () => {
      while (received.join('').split('\n\n').length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        received.push(decoder.decode(value));
      }
    })();

    // Laisser le temps au handler d'enregistrer le client.
    await new Promise((r) => setTimeout(r, 50));
    hub.broadcast('c1', '{"type":"token","delta":"Hi"}');

    await Promise.race([readUntil, new Promise((r) => setTimeout(r, 500))]);
    ctrl.abort();
    expect(received.join('')).toContain('data: {"type":"token","delta":"Hi"}');
  });
});
