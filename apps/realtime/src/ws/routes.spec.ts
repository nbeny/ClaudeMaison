import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { TokenClaims, TokenVerifier } from '../auth';
import type { ConnectionHub } from './hub';
import { registerWsRoutes } from './routes';

// /ws/v1/stream est la porte WebSocket : token + channel en query
// string (le browser ne peut pas envoyer de headers à l'upgrade).
// Deux gardes :
//   1. token+channel présents → sinon close 1008 "missing token or channel"
//   2. token valide            → sinon close 1008 "auth rejected"
// Note : à date, pas d'ACL côté WS (cf. TODO dans routes.ts), contrairement
// au SSE. Ces tests verrouillent la surface actuelle — si quelqu'un ajoute
// l'ACL plus tard et casse l'ordre, les tests le rattraperont.

const CLAIMS: TokenClaims = { sub: 'u-1', sid: 's-1' };

interface Deps {
  verifier: TokenVerifier;
  hub: ConnectionHub;
  app: FastifyInstance;
  baseUrl: string;
}

async function makeDeps(verifyImpl?: (token: string) => Promise<TokenClaims>): Promise<Deps> {
  const verifier = {
    verify: vi.fn(verifyImpl ?? (async () => CLAIMS)),
  } as unknown as TokenVerifier;
  const hub = {
    add: vi.fn(),
    remove: vi.fn(),
    broadcast: vi.fn(),
    size: vi.fn(() => 0),
  } as unknown as ConnectionHub;

  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  registerWsRoutes(app, { verifier, hub });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { verifier, hub, app, baseUrl: `ws://127.0.0.1:${addr.port}` };
}

/** Ouvre une WS et attend le `close` event ; renvoie {code, reason}. */
function awaitClose(url: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout waiting for close'));
    }, 3000);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      // Sur certains close, ws émet aussi 'error' — on ignore, on attend close.
    });
  });
}

/** Ouvre une WS et collecte les messages reçus jusqu'au close. */
function collectUntilClose(url: string): Promise<{ messages: string[]; closed: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages: string[] = [];
    const done = (): void => resolve({ messages, closed: ws.readyState === ws.CLOSED });
    ws.on('message', (data) => {
      messages.push(data.toString());
      // On ferme côté client une fois le 1er message reçu — sinon le test reste ouvert.
      ws.close();
    });
    ws.on('close', done);
    setTimeout(() => {
      ws.terminate();
      done();
    }, 2000);
  });
}

describe('WS route — porte 1 : token+channel présents', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = await makeDeps();
  });
  afterEach(async () => {
    await deps.app.close();
  });

  it('close 1008 "missing token or channel" si token absent', async () => {
    const { code, reason } = await awaitClose(`${deps.baseUrl}/ws/v1/stream?channel=c1`);
    expect(code).toBe(1008);
    expect(reason).toBe('missing token or channel');
    expect(deps.verifier.verify).not.toHaveBeenCalled();
    expect(deps.hub.add).not.toHaveBeenCalled();
  });

  it('close 1008 "missing token or channel" si channel absent', async () => {
    const { code, reason } = await awaitClose(`${deps.baseUrl}/ws/v1/stream?token=t`);
    expect(code).toBe(1008);
    expect(reason).toBe('missing token or channel');
    expect(deps.verifier.verify).not.toHaveBeenCalled();
    expect(deps.hub.add).not.toHaveBeenCalled();
  });

  it('close 1008 si les deux sont absents (pas de URL handler-time crash)', async () => {
    const { code } = await awaitClose(`${deps.baseUrl}/ws/v1/stream`);
    expect(code).toBe(1008);
  });
});

describe('WS route — porte 2 : token valide', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = await makeDeps(async () => {
      throw new Error('bad signature');
    });
  });
  afterEach(async () => {
    await deps.app.close();
  });

  it('close 1008 "auth rejected" si verifier.verify rejette', async () => {
    const { code, reason } = await awaitClose(
      `${deps.baseUrl}/ws/v1/stream?token=garbage&channel=c1`,
    );
    expect(code).toBe(1008);
    expect(reason).toBe('auth rejected');
    // CRITIQUE : pas d'enregistrement dans le hub pour un token invalide.
    expect(deps.hub.add).not.toHaveBeenCalled();
  });

  it('passe le token (pas l\'URL) à verifier.verify', async () => {
    await awaitClose(`${deps.baseUrl}/ws/v1/stream?token=tok-xyz&channel=c1`);
    expect(deps.verifier.verify).toHaveBeenCalledWith('tok-xyz');
  });
});

describe('WS route — happy path', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = await makeDeps();
  });
  afterEach(async () => {
    await deps.app.close();
  });

  it('envoie {type:"subscribed", channel} après auth OK', async () => {
    const { messages } = await collectUntilClose(
      `${deps.baseUrl}/ws/v1/stream?token=t&channel=my-chan`,
    );
    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]!) as { type: string; channel: string };
    expect(parsed).toEqual({ type: 'subscribed', channel: 'my-chan' });
  });

  it('enregistre l\'entry dans le hub avec userId=claims.sub et channel', async () => {
    await collectUntilClose(`${deps.baseUrl}/ws/v1/stream?token=t&channel=my-chan`);
    expect(deps.hub.add).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(deps.hub.add).mock.calls[0]![0];
    expect(entry.userId).toBe(CLAIMS.sub);
    expect(entry.channel).toBe('my-chan');
    expect(entry.socket).toBeDefined();
  });

  it('appelle hub.remove quand le client ferme la connexion', async () => {
    await collectUntilClose(`${deps.baseUrl}/ws/v1/stream?token=t&channel=my-chan`);
    // Laisser au serveur le temps de propager le close event.
    await new Promise((r) => setTimeout(r, 100));
    expect(deps.hub.remove).toHaveBeenCalledTimes(1);
  });
});
