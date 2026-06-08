import { EventEmitter } from 'node:events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenClaims, TokenVerifier } from '../auth';
import type { SseEntry, SseHub } from './hub';
import { type ConversationAcl, registerSseRoutes } from './routes';

// Caractérisation routes SSE — invariants subtils NON couverts par routes.spec.ts.
//
// routes.spec.ts couvre les 3 gardes (token présent / valide / ACL) et
// l'ordre d'invocation. Ce fichier verrouille tout le reste, qui est
// invisible dans une assertion sur le status code mais critique :
//
//   - **reply.hijack() arrive APRÈS toutes les early-returns** : si on
//     hijack avant un 401/403, Fastify n'envoie plus reply.send() au
//     client → l'attaquant voit un timeout / socket coupée au lieu d'un
//     401 propre. Pire : la SSE error JSON ne part jamais.
//
//   - **Headers SSE exacts** : Content-Type=text/event-stream est NON
//     NÉGOCIABLE — sans ce header, EventSource côté browser refuse
//     d'interpréter le stream. Cache-Control=no-cache empêche un proxy
//     de buffer le payload. Connection=keep-alive empêche HTTP/1.1
//     close. X-Accel-Buffering=no est nginx-spécifique : sans ça, nginx
//     bufferise 4KB et le premier token n'arrive jamais en temps réel.
//
//   - **flushHeaders() après writeHead** : si on omet flushHeaders, le
//     client fetch()/EventSource attend le premier byte applicatif avant
//     de résoudre. Sur une conversation lente (LLM cold start ~3s), le
//     timeout client (généralement 1s) déclenche avant le premier token.
//
//   - **Heartbeat = `:keepalive\n\n` (commentaire SSE, PAS un event)** :
//     un `data: ...\n\n` ferait fire `EventSource.onmessage` côté client
//     toutes les 15s avec un payload vide → handlers JS pollués. Un
//     `:` ouvre une ligne de COMMENTAIRE SSE silencieuse, juste pour
//     garder la TCP socket vivante.
//
//   - **Intervalle = 15_000 ms exact** : assez court pour devancer le
//     proxy timeout (nginx default 60s, Cloudflare ~100s). Bump silencieux
//     à 120s = sockets coupées par le reverse proxy avant le keepalive.
//
//   - **Heartbeat cleanup sur reply.raw.destroyed** : sans cleanup, on
//     leak un setInterval qui write() sur socket morte → EPIPE async
//     non-catché → crash worker Node.
//
//   - **Heartbeat cleanup sur write() qui throw** : défense en profondeur
//     contre les sockets dans un état intermédiaire (post-FIN, pre-close).
//
//   - **req.raw.on('close') → cleanup** : événement de cycle de vie
//     standard. Sans le clearInterval, chaque déconnexion client laisse
//     un timer actif pour toujours → memory leak proportionnel au churn.
//
//   - **SseEntry shape : userId=claims.sub, channel=conversationId** : si
//     les deux champs sont inversés, l'ACL de canRead("conv-id", "user-id")
//     refuse tout (ou pire : autorise par accident pour des IDs courts) et
//     les broadcasts envoient sur le mauvais channel.
//
//   - **hub.add appelé exactement UNE fois sur le happy path** : un
//     double add() doublerait toutes les notifications côté ce client.

interface MockRawResponse {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  flushHeaders: ReturnType<typeof vi.fn>;
  destroyed: boolean;
}

interface CapturedHandler {
  (
    req: Partial<FastifyRequest> & {
      query: { token?: string };
      params: { conversationId: string };
      raw: EventEmitter;
    },
    reply: Partial<FastifyReply> & {
      code: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      hijack: ReturnType<typeof vi.fn>;
      raw: MockRawResponse;
    },
  ): Promise<void>;
}

const CLAIMS: TokenClaims = { sub: 'u-42', sid: 'sid-7' };
const CONVERSATION_ID = 'conv-abc';

function captureHandler(deps: {
  verifier: TokenVerifier;
  hub: SseHub;
  acl: ConversationAcl;
}): CapturedHandler {
  let captured: CapturedHandler | undefined;
  // Fausse FastifyInstance : on intercepte uniquement app.get pour capturer
  // le handler. Pas besoin d'une vraie app — on appelle le handler
  // directement avec des mocks req/reply, ce qui rend le contrôle des
  // mocks (reply.raw, req.raw 'close', interval timer) déterministe.
  const fakeApp = {
    get: (_path: string, handler: CapturedHandler) => {
      captured = handler;
    },
  } as unknown as FastifyInstance;
  registerSseRoutes(fakeApp, deps);
  if (!captured) throw new Error('handler not captured');
  return captured;
}

function makeMocks(opts: { token?: string; conversationId?: string } = {}): {
  req: Parameters<CapturedHandler>[0];
  reply: Parameters<CapturedHandler>[1];
  rawReq: EventEmitter;
} {
  const rawReq = new EventEmitter();
  const req = {
    query: { token: opts.token },
    params: { conversationId: opts.conversationId ?? CONVERSATION_ID },
    raw: rawReq,
  } as Parameters<CapturedHandler>[0];
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    hijack: vi.fn().mockReturnThis(),
    raw: {
      writeHead: vi.fn(),
      write: vi.fn(),
      flushHeaders: vi.fn(),
      destroyed: false,
    },
  } as Parameters<CapturedHandler>[1];
  return { req, reply, rawReq };
}

function makeDeps(overrides: {
  verifyImpl?: (token: string) => Promise<TokenClaims>;
  canReadImpl?: (userId: string, conv: string) => Promise<boolean>;
} = {}): {
  verifier: TokenVerifier;
  hub: SseHub;
  acl: ConversationAcl;
} {
  const verifier = {
    verify: vi.fn(overrides.verifyImpl ?? (async () => CLAIMS)),
  } as unknown as TokenVerifier;
  const acl = {
    canRead: vi.fn(overrides.canReadImpl ?? (async () => true)),
  } as ConversationAcl;
  const hub = {
    add: vi.fn(),
    remove: vi.fn(),
    broadcast: vi.fn(),
    size: vi.fn(),
  } as unknown as SseHub;
  return { verifier, hub, acl };
}

describe('SSE route — hijack() ordering', () => {
  it("ne hijack PAS sur 401 missing token (sinon le 401 ne part jamais au client)", async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: undefined });

    await handler(req, reply);

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'missing token' });
    // raw.* ne doit pas avoir été touché — c'est le signal qu'on est
    // resté sur le chemin Fastify nominal.
    expect(reply.raw.writeHead).not.toHaveBeenCalled();
    expect(reply.raw.flushHeaders).not.toHaveBeenCalled();
  });

  it('ne hijack PAS sur 401 invalid token', async () => {
    const deps = makeDeps({
      verifyImpl: async () => {
        throw new Error('bad sig');
      },
    });
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'garbage' });

    await handler(req, reply);

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'invalid token' });
  });

  it('ne hijack PAS sur 403 forbidden', async () => {
    const deps = makeDeps({ canReadImpl: async () => false });
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'forbidden' });
    expect(reply.raw.writeHead).not.toHaveBeenCalled();
  });

  it('hijack une seule fois sur le happy path, AVANT writeHead', async () => {
    const order: string[] = [];
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });
    reply.hijack.mockImplementation(() => {
      order.push('hijack');
      return reply as FastifyReply;
    });
    reply.raw.writeHead.mockImplementation(() => {
      order.push('writeHead');
    });

    await handler(req, reply);

    expect(order).toEqual(['hijack', 'writeHead']);
    expect(reply.hijack).toHaveBeenCalledTimes(1);
  });
});

describe('SSE route — headers de réponse', () => {
  it('writeHead émet status=200', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    expect(reply.raw.writeHead).toHaveBeenCalledOnce();
    const [status] = reply.raw.writeHead.mock.calls[0]!;
    expect(status).toBe(200);
  });

  it('headers contiennent EXACTEMENT Content-Type=text/event-stream', async () => {
    // Sans ce content-type, EventSource côté browser refuse de parser.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    const [, headers] = reply.raw.writeHead.mock.calls[0]!;
    expect(headers['Content-Type']).toBe('text/event-stream');
  });

  it('headers contiennent Cache-Control=no-cache (anti-buffering proxy)', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    const [, headers] = reply.raw.writeHead.mock.calls[0]!;
    expect(headers['Cache-Control']).toBe('no-cache');
  });

  it('headers contiennent Connection=keep-alive (anti-HTTP/1.1 close auto)', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    const [, headers] = reply.raw.writeHead.mock.calls[0]!;
    expect(headers['Connection']).toBe('keep-alive');
  });

  it('headers contiennent X-Accel-Buffering=no (anti-nginx 4KB buffer)', async () => {
    // Nginx en mode proxy bufferise 4KB par défaut. Sans ce header, le
    // premier token LLM (souvent <100 bytes) ne sort qu'au flush du 4KB.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    const [, headers] = reply.raw.writeHead.mock.calls[0]!;
    expect(headers['X-Accel-Buffering']).toBe('no');
  });

  it('flushHeaders() est appelé APRÈS writeHead (client fetch resolve immédiat)', async () => {
    const order: string[] = [];
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });
    reply.raw.writeHead.mockImplementation(() => {
      order.push('writeHead');
    });
    reply.raw.flushHeaders.mockImplementation(() => {
      order.push('flushHeaders');
    });

    await handler(req, reply);

    expect(order).toEqual(['writeHead', 'flushHeaders']);
    expect(reply.raw.flushHeaders).toHaveBeenCalledOnce();
  });
});

describe('SSE route — SseEntry shape et hub.add', () => {
  it('entry.userId = claims.sub (PAS le conversationId)', async () => {
    const deps = makeDeps({
      verifyImpl: async () => ({ sub: 'alice', sid: 's-alice' }),
    });
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    expect(deps.hub.add).toHaveBeenCalledOnce();
    const entry = vi.mocked(deps.hub.add).mock.calls[0]![0] as SseEntry;
    expect(entry.userId).toBe('alice');
    expect(entry.userId).not.toBe(CONVERSATION_ID);
  });

  it('entry.channel = conversationId (PAS le userId)', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok', conversationId: 'conv-xyz' });

    await handler(req, reply);

    const entry = vi.mocked(deps.hub.add).mock.calls[0]![0] as SseEntry;
    expect(entry.channel).toBe('conv-xyz');
    expect(entry.channel).not.toBe(CLAIMS.sub);
  });

  it('entry.reply = la FastifyReply (référence, pas un clone)', async () => {
    // Le hub.broadcast écrit sur entry.reply.raw.write. Si on stockait
    // un clone, le clone ne porterait pas la même socket → broadcast
    // silencieusement ineffectif.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    const entry = vi.mocked(deps.hub.add).mock.calls[0]![0] as SseEntry;
    expect(entry.reply).toBe(reply); // identité de référence
  });

  it('hub.add appelé exactement UNE fois sur le happy path', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    expect(deps.hub.add).toHaveBeenCalledTimes(1);
  });

  it('hub.add appelé APRÈS flushHeaders (subscription enregistrée seulement quand le client est prêt)', async () => {
    // Si on add() avant flushHeaders, un broadcast immédiat écrirait
    // dans un buffer non-flushé → le client recevrait l'event après
    // le premier flush, casse l'ordre temporel observable.
    const order: string[] = [];
    const deps = makeDeps();
    vi.mocked(deps.hub.add).mockImplementation(() => {
      order.push('hub.add');
    });
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });
    reply.raw.flushHeaders.mockImplementation(() => {
      order.push('flushHeaders');
    });

    await handler(req, reply);

    expect(order).toEqual(['flushHeaders', 'hub.add']);
  });
});

describe('SSE route — heartbeat (intervalle, contenu, cleanup)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("intervalle = 15_000 ms exact (devance les timeouts proxy)", async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    // À t=0, aucun keepalive émis.
    expect(reply.raw.write).not.toHaveBeenCalled();
    // À t=14_999, toujours rien.
    vi.advanceTimersByTime(14_999);
    expect(reply.raw.write).not.toHaveBeenCalled();
    // À t=15_000, exactement 1 keepalive.
    vi.advanceTimersByTime(1);
    expect(reply.raw.write).toHaveBeenCalledOnce();
  });

  it("contenu = ':keepalive\\n\\n' (commentaire SSE, PAS un event data:)", async () => {
    // Un `data: keepalive\n\n` ferait fire EventSource.onmessage côté
    // client avec un payload vide → handlers JS pollués toutes les 15s.
    // Le préfixe `:` ouvre une ligne de COMMENTAIRE SSE invisible côté
    // application — utile uniquement pour garder la TCP socket vivante.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);
    vi.advanceTimersByTime(15_000);

    expect(reply.raw.write).toHaveBeenCalledWith(':keepalive\n\n');
    // Pas de "data: " : c'est crucial.
    const payload = reply.raw.write.mock.calls[0]![0] as string;
    expect(payload.startsWith('data:')).toBe(false);
    expect(payload.startsWith(':')).toBe(true);
  });

  it('émet périodiquement (pas une seule fois) — 3 ticks → 3 writes', async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);
    vi.advanceTimersByTime(45_000); // 3 × 15s

    expect(reply.raw.write).toHaveBeenCalledTimes(3);
  });

  it('heartbeat skip + cleanup si reply.raw.destroyed (anti EPIPE async)', async () => {
    // Si la socket est destroyed, write() throw async non-catché en
    // dehors d'un try → crash event-loop. Le heartbeat doit détecter
    // l'état destroyed AVANT d'écrire, et nettoyer l'interval + hub.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });

    await handler(req, reply);
    reply.raw.destroyed = true;

    vi.advanceTimersByTime(15_000);

    // Pas de write parce que destroyed.
    expect(reply.raw.write).not.toHaveBeenCalled();
    // hub.remove appelé avec la même entry que add.
    expect(deps.hub.remove).toHaveBeenCalledOnce();
    const removed = vi.mocked(deps.hub.remove).mock.calls[0]![0];
    const added = vi.mocked(deps.hub.add).mock.calls[0]![0];
    expect(removed).toBe(added); // identité de référence

    // Le timer a été cleared : un 2e advance n'émet rien de plus.
    vi.advanceTimersByTime(60_000);
    expect(deps.hub.remove).toHaveBeenCalledTimes(1);
  });

  it('heartbeat cleanup si write() throw (défense en profondeur)', async () => {
    // Si destroyed est false MAIS write() throw quand même (état
    // intermédiaire post-FIN), le catch interne nettoie : clearInterval
    // + hub.remove. Sans ce catch, un setInterval continuerait à throw
    // toutes les 15s sur une socket morte.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply } = makeMocks({ token: 'ok' });
    reply.raw.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });

    await handler(req, reply);
    vi.advanceTimersByTime(15_000);

    expect(deps.hub.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    // Le timer est cleared : pas de 2e write tenté.
    expect(reply.raw.write).toHaveBeenCalledTimes(1);
  });
});

describe('SSE route — req.raw on(close) cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("close client → clearInterval + hub.remove", async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply, rawReq } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    // Avant close : aucun remove.
    expect(deps.hub.remove).not.toHaveBeenCalled();

    rawReq.emit('close');

    expect(deps.hub.remove).toHaveBeenCalledOnce();
    // L'entry removed === l'entry added.
    const removed = vi.mocked(deps.hub.remove).mock.calls[0]![0];
    const added = vi.mocked(deps.hub.add).mock.calls[0]![0];
    expect(removed).toBe(added);

    // Le timer est cleared : aucun keepalive même après 60s.
    vi.advanceTimersByTime(60_000);
    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it("close après plusieurs heartbeats arrête les nouveaux ticks", async () => {
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply, rawReq } = makeMocks({ token: 'ok' });

    await handler(req, reply);
    vi.advanceTimersByTime(30_000); // 2 ticks
    expect(reply.raw.write).toHaveBeenCalledTimes(2);

    rawReq.emit('close');
    vi.advanceTimersByTime(60_000);

    // Aucun tick supplémentaire après close.
    expect(reply.raw.write).toHaveBeenCalledTimes(2);
  });

  it("close handler enregistré UNE fois par requête (anti double cleanup)", async () => {
    // Si on enregistrait 2 listeners 'close', hub.remove serait appelé
    // 2 fois → l'idempotence côté hub absorbe, mais c'est un signe de
    // bug sous-jacent. On vérifie le count des listeners 'close'.
    const deps = makeDeps();
    const handler = captureHandler(deps);
    const { req, reply, rawReq } = makeMocks({ token: 'ok' });

    await handler(req, reply);

    expect(rawReq.listenerCount('close')).toBe(1);
  });
});

describe("SSE route — pas de side-effect sur les chemins d'erreur", () => {
  it('401 missing token → ni writeHead, ni flushHeaders, ni hub.add, ni setInterval', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const handler = captureHandler(deps);
      const { req, reply } = makeMocks({ token: undefined });

      await handler(req, reply);

      expect(reply.raw.writeHead).not.toHaveBeenCalled();
      expect(reply.raw.flushHeaders).not.toHaveBeenCalled();
      expect(reply.raw.write).not.toHaveBeenCalled();
      expect(deps.hub.add).not.toHaveBeenCalled();

      // Pas d'interval pending : un advance massif n'appelle aucun callback.
      vi.advanceTimersByTime(60_000);
      expect(reply.raw.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('403 forbidden → ni hub.add, ni setInterval', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps({ canReadImpl: async () => false });
      const handler = captureHandler(deps);
      const { req, reply } = makeMocks({ token: 'ok' });

      await handler(req, reply);
      vi.advanceTimersByTime(60_000);

      expect(deps.hub.add).not.toHaveBeenCalled();
      expect(reply.raw.write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('401 invalid token → req.raw close handler PAS enregistré', async () => {
    // Si le close handler est enregistré avant le check d'auth, un
    // disconnect émettrait un hub.remove sur une entry qui n'a jamais
    // été add → log d'erreur ou comportement indéfini selon le hub.
    const deps = makeDeps({
      verifyImpl: async () => {
        throw new Error('bad');
      },
    });
    const handler = captureHandler(deps);
    const { req, reply, rawReq } = makeMocks({ token: 'garbage' });

    await handler(req, reply);

    expect(rawReq.listenerCount('close')).toBe(0);
  });
});
