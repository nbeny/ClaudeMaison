import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// On mocke 'nats' AVANT l'import de NatsSubscriber pour pouvoir contrôler
// les retours de `connect()` et `connection.subscribe()` sans toucher au
// vrai broker. `vi.hoisted` permet aux mocks d'exister au moment où la
// factory de `vi.mock` s'exécute (les mocks sont hoist en haut du fichier).
const { connectMock, codecEncode } = vi.hoisted(() => {
  return {
    connectMock: vi.fn(),
    codecEncode: (s: string) => new TextEncoder().encode(s),
  };
});

vi.mock('nats', () => ({
  connect: connectMock,
  // Notre StringCodec réel utilise TextEncoder/TextDecoder côté lib ;
  // on simule pareil pour que decode() rende la string source.
  StringCodec: () => ({
    encode: codecEncode,
    decode: (buf: Uint8Array) => new TextDecoder().decode(buf),
  }),
}));

import { NatsSubscriber, type Broadcastable } from './subscriber';

// NatsSubscriber est le pont NATS → hubs (SSE + WS). Pour chaque message
// reçu sur `events.<channelId>`, il extrait le channel et broadcaste à
// TOUS les hubs configurés. Les invariants critiques :
//
//   - Le sujet wildcard `events.>` est utilisé (pas `events.*` qui ne
//     matcherait pas les sujets multi-tokens type `events.chat.foo`).
//
//   - Le préfixe `events.` est exactement strippé — pas un slice naïf
//     `slice(7)` qui casserait si on renomme la racine.
//
//   - Tous les hubs reçoivent le broadcast, pas seulement le premier.
//     Sinon : un message NATS pour un user en SSE arriverait si SSE est
//     en tête, mais pas pour un user en WS si WS est en deuxième
//     position (selon l'ordre de l'array → bug invisible en config).
//
//   - Si UN hub throw, les autres hubs reçoivent toujours et la boucle
//     ne meurt pas. Crucial : sans ça, une exception dans SseHub
//     tuerait la livraison à ConnectionHub pour tous les users à venir
//     sur cette instance jusqu'au redémarrage.
//
//   - L'erreur d'un hub est logguée (observable côté ops).
//
//   - stop() appelle `connection.drain()` (vidage propre, pas close
//     brutal qui perd les messages en vol).

interface FakeMsg {
  subject: string;
  data: Uint8Array;
}

function makeMsg(subject: string, payload: string): FakeMsg {
  return { subject, data: codecEncode(payload) };
}

function makeAsyncIterable(msgs: FakeMsg[]): AsyncIterable<FakeMsg> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of msgs) yield m;
    },
  };
}

interface SubscribeMock {
  subscribe: ReturnType<typeof vi.fn>;
  drain: ReturnType<typeof vi.fn>;
}

function mockConnectionWith(msgs: FakeMsg[]): SubscribeMock {
  const subscribe = vi.fn().mockReturnValue(makeAsyncIterable(msgs));
  const drain = vi.fn().mockResolvedValue(undefined);
  const conn = { subscribe, drain };
  connectMock.mockResolvedValue(conn);
  return conn;
}

function makeHub(label: string): Broadcastable & { calls: { channel: string; payload: string }[]; label: string } {
  const calls: { channel: string; payload: string }[] = [];
  return {
    label,
    calls,
    broadcast: vi.fn((channel: string, payload: string) => {
      calls.push({ channel, payload });
      return 1;
    }),
  };
}

// Helper : attend que le loop async interne ait consommé tous les
// messages. On laisse passer 2 microtasks — le for-await + le forwarding.
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  connectMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('NatsSubscriber.start — connexion & souscription', () => {
  it('connecte avec l\'URL fournie en constructeur', async () => {
    mockConnectionWith([]);
    const sub = new NatsSubscriber('nats://broker:4222', [], () => {});
    await sub.start();
    expect(connectMock).toHaveBeenCalledWith({ servers: 'nats://broker:4222' });
  });

  it('souscrit au wildcard `events.>` (pas `events.*` ni `events.`)', async () => {
    // `events.*` ne matche QUE 1 token, donc `events.chat.foo` serait
    // ignoré. `>` matche tout suffixe. Lock-in.
    const conn = mockConnectionWith([]);
    const sub = new NatsSubscriber('nats://x', [], () => {});
    await sub.start();
    expect(conn.subscribe).toHaveBeenCalledWith('events.>');
  });

  it('logge "nats connected" après connect() OK', async () => {
    mockConnectionWith([]);
    const log = vi.fn();
    const sub = new NatsSubscriber('nats://x', [], log);
    await sub.start();
    const lines = log.mock.calls.map((c) => c[0]);
    expect(lines.some((l: string) => l.includes('nats connected'))).toBe(true);
  });
});

describe('NatsSubscriber.start — fan-out vers tous les hubs', () => {
  it('extrait le channel = sujet sans le préfixe "events."', async () => {
    mockConnectionWith([makeMsg('events.chat-42', '{"token":"hi"}')]);
    const h = makeHub('sse');
    const sub = new NatsSubscriber('nats://x', [h], () => {});
    await sub.start();
    await flushAsync();
    expect(h.calls).toEqual([{ channel: 'chat-42', payload: '{"token":"hi"}' }]);
  });

  it('préserve les dots dans le channel (events.chat.nested → chat.nested)', async () => {
    // CRITIQUE : un slice à longueur fixe `slice(7)` peut sembler
    // équivalent à `slice('events.'.length)` mais devient fragile si
    // on renomme le préfixe. On lock-in le comportement actuel.
    mockConnectionWith([makeMsg('events.chat.nested', 'p')]);
    const h = makeHub('sse');
    const sub = new NatsSubscriber('nats://x', [h], () => {});
    await sub.start();
    await flushAsync();
    expect(h.calls).toEqual([{ channel: 'chat.nested', payload: 'p' }]);
  });

  it('broadcaste à TOUS les hubs (pas seulement le premier)', async () => {
    // Régression typique : un break à l'intérieur de la boucle for-of
    // arrêterait après le premier hub. Lock pour les deux modalités
    // SSE + WS en parallèle (le main.ts wire [wsHub, sseHub]).
    mockConnectionWith([makeMsg('events.chat-1', 'p')]);
    const ws = makeHub('ws');
    const sse = makeHub('sse');
    const sub = new NatsSubscriber('nats://x', [ws, sse], () => {});
    await sub.start();
    await flushAsync();
    expect(ws.calls).toEqual([{ channel: 'chat-1', payload: 'p' }]);
    expect(sse.calls).toEqual([{ channel: 'chat-1', payload: 'p' }]);
  });

  it('itère plusieurs messages en gardant l\'ordre', async () => {
    mockConnectionWith([
      makeMsg('events.chat-1', 'a'),
      makeMsg('events.chat-1', 'b'),
      makeMsg('events.chat-1', 'c'),
    ]);
    const h = makeHub('sse');
    const sub = new NatsSubscriber('nats://x', [h], () => {});
    await sub.start();
    await flushAsync();
    expect(h.calls.map((c) => c.payload)).toEqual(['a', 'b', 'c']);
  });
});

describe('NatsSubscriber.start — isolation des erreurs entre hubs', () => {
  it('si UN hub throw, les autres hubs reçoivent quand même le broadcast', async () => {
    // CRITIQUE : sans isolation, une exception dans SseHub.broadcast
    // (ex: bug sur un payload spécial) tuerait la livraison à WS pour
    // tous les users de la même instance. Le try/catch par hub doit
    // garantir l'indépendance.
    mockConnectionWith([makeMsg('events.chat-1', 'p')]);
    const throwing: Broadcastable = {
      broadcast: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const healthy = makeHub('ws');
    const sub = new NatsSubscriber('nats://x', [throwing, healthy], () => {});
    await sub.start();
    await flushAsync();
    expect(healthy.calls).toEqual([{ channel: 'chat-1', payload: 'p' }]);
  });

  it('logge l\'erreur du hub avec le channel (debug ops)', async () => {
    mockConnectionWith([makeMsg('events.chat-9', 'p')]);
    const throwing: Broadcastable = {
      broadcast: vi.fn(() => {
        throw new Error('explode');
      }),
    };
    const log = vi.fn();
    const sub = new NatsSubscriber('nats://x', [throwing], log);
    await sub.start();
    await flushAsync();
    // Le log doit contenir au moins une mention de "hub broadcast failed"
    // avec l'objet extra contenant `channel`.
    const errLines = log.mock.calls.filter((c) => String(c[0]).includes('hub broadcast'));
    expect(errLines.length).toBeGreaterThan(0);
    expect(errLines[0]![1]).toMatchObject({ channel: 'chat-9' });
  });

  it('si un message fait throw un hub, le message SUIVANT est quand même traité', async () => {
    // Lock-in : l'erreur ne stoppe pas le for-await. Sans le try/catch
    // *à l'intérieur* de l'itération, la promesse rejetée tuerait
    // tout le loop NATS pour cette instance.
    mockConnectionWith([
      makeMsg('events.chat-1', 'p1'),
      makeMsg('events.chat-1', 'p2'),
    ]);
    let count = 0;
    const flaky: Broadcastable = {
      broadcast: vi.fn(() => {
        count++;
        if (count === 1) throw new Error('first fails');
        return 1;
      }),
    };
    const sub = new NatsSubscriber('nats://x', [flaky], () => {});
    await sub.start();
    await flushAsync();
    expect(count).toBe(2);
  });
});

describe('NatsSubscriber.stop', () => {
  it('appelle connection.drain() (pas close brutal)', async () => {
    // drain() vide les messages en vol avant de fermer ; close() coupe
    // sec. Pour des services derrière un load-balancer pendant un
    // graceful shutdown, drain() est ce qu'on veut.
    const conn = mockConnectionWith([]);
    const sub = new NatsSubscriber('nats://x', [], () => {});
    await sub.start();
    await sub.stop();
    expect(conn.drain).toHaveBeenCalled();
  });

  it('noop si stop() appelé sans start() préalable (pas de crash)', async () => {
    const sub = new NatsSubscriber('nats://x', [], () => {});
    await expect(sub.stop()).resolves.toBeUndefined();
  });

  it('après stop(), un deuxième stop() ne re-drain pas', async () => {
    const conn = mockConnectionWith([]);
    const sub = new NatsSubscriber('nats://x', [], () => {});
    await sub.start();
    await sub.stop();
    await sub.stop();
    expect(conn.drain).toHaveBeenCalledTimes(1);
  });
});
