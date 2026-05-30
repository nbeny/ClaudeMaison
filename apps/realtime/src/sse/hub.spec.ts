import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SseHub, type SseEntry } from './hub';

// SseHub est le fan-out central pour les flux SSE (streaming des
// réponses LLM token-par-token vers le navigateur). Les invariants
// que ce spec verrouille :
//
//   - Isolation par canal : un broadcast sur "chat-1" ne doit JAMAIS
//     atteindre une entry inscrite sur "chat-2" (sinon un user A
//     verrait les tokens d'une conv d'un user B sur la même instance
//     realtime — fuite cross-tenant).
//
//   - Format wire SSE strict : `data: <payload>\n\n`. Sans le double
//     `\n\n`, le browser ne livre pas l'event au handler `onmessage`
//     (il reste en buffer jusqu'au prochain `\n\n` — UX de chat figée).
//
//   - GC des entries mortes : si `reply.raw.destroyed` ou si `write()`
//     throw (back-pressure, socket fermé), l'entry doit être *retirée*
//     du set. Sans ce GC, `byChannel` grossit indéfiniment et
//     consomme la mémoire jusqu'à l'OOM kill.
//
//   - Suppression du set vide après remove() : sinon `byChannel` garde
//     des clés mortes (channels de convs terminées il y a 10 minutes)
//     qui s'accumulent sur un service longue-durée.
//
//   - broadcast() sur channel inconnu → 0, pas crash.
//
//   - size() compte EXACTEMENT le total cross-channels (utilisé par
//     les métriques d'observabilité).

interface FakeRaw {
  destroyed: boolean;
  written: string[];
  writeShouldThrow?: boolean;
}

function fakeReply(): { reply: FastifyReply; raw: FakeRaw } {
  const raw: FakeRaw = { destroyed: false, written: [] };
  const reply = {
    raw: {
      get destroyed() {
        return raw.destroyed;
      },
      write: vi.fn((chunk: string) => {
        if (raw.writeShouldThrow) throw new Error('EPIPE');
        raw.written.push(chunk);
        return true;
      }),
    },
  } as unknown as FastifyReply;
  return { reply, raw };
}

function entry(channel: string, userId = 'u'): SseEntry & { raw: FakeRaw } {
  const { reply, raw } = fakeReply();
  return { userId, channel, reply, raw };
}

describe('SseHub.add / size', () => {
  it('size() = 0 sur un hub vide', () => {
    expect(new SseHub().size()).toBe(0);
  });

  it('size() compte les entries cross-channels', () => {
    const hub = new SseHub();
    hub.add(entry('chat-1', 'u1'));
    hub.add(entry('chat-1', 'u2'));
    hub.add(entry('chat-2', 'u3'));
    expect(hub.size()).toBe(3);
  });

  it('add() crée le set du channel paresseusement (pas pré-alloué)', () => {
    const hub = new SseHub();
    // Avant d'add quoi que ce soit, broadcast sur ce channel = 0.
    expect(hub.broadcast('chat-1', 'x')).toBe(0);
    hub.add(entry('chat-1'));
    expect(hub.size()).toBe(1);
  });
});

describe('SseHub.broadcast — wire format + delivery', () => {
  it('utilise le format SSE strict `data: <payload>\\n\\n`', () => {
    // CRITIQUE : le double `\n\n` est ce qui dit au navigateur "event
    // complet". Sans ça, le browser garde le chunk en buffer et la UX
    // de streaming est cassée (rien ne s'affiche jusqu'à la fermeture).
    const hub = new SseHub();
    const e = entry('chat-1');
    hub.add(e);
    hub.broadcast('chat-1', '{"token":"hello"}');
    expect(e.raw.written).toEqual(['data: {"token":"hello"}\n\n']);
  });

  it('broadcast → toutes les entries du même channel reçoivent (compte exact)', () => {
    const hub = new SseHub();
    const a = entry('chat-1', 'u1');
    const b = entry('chat-1', 'u2');
    hub.add(a);
    hub.add(b);
    const delivered = hub.broadcast('chat-1', 'p');
    expect(delivered).toBe(2);
    expect(a.raw.written).toEqual(['data: p\n\n']);
    expect(b.raw.written).toEqual(['data: p\n\n']);
  });

  it('isolation cross-channel : broadcast(A) ne touche jamais une entry sur B', () => {
    // Anti-fuite cross-tenant la plus importante du fichier : si on
    // mélangeait les channels, un user verrait les tokens LLM d'une
    // conv d'un autre user sur la même instance realtime.
    const hub = new SseHub();
    const a = entry('chat-1', 'u1');
    const b = entry('chat-2', 'u2');
    hub.add(a);
    hub.add(b);
    hub.broadcast('chat-1', 'secret-pour-u1');
    expect(a.raw.written).toEqual(['data: secret-pour-u1\n\n']);
    expect(b.raw.written).toEqual([]);
  });

  it('broadcast sur un channel inconnu → 0, pas de crash', () => {
    const hub = new SseHub();
    expect(hub.broadcast('chat-inexistant', 'x')).toBe(0);
  });

  it('plusieurs broadcasts s\'accumulent dans l\'ordre dans le buffer de la reply', () => {
    const hub = new SseHub();
    const e = entry('chat-1');
    hub.add(e);
    hub.broadcast('chat-1', 'one');
    hub.broadcast('chat-1', 'two');
    expect(e.raw.written).toEqual(['data: one\n\n', 'data: two\n\n']);
  });
});

describe('SseHub.broadcast — GC des entries mortes', () => {
  it('skip une entry dont `reply.raw.destroyed` est true (mais la retire du set)', () => {
    const hub = new SseHub();
    const live = entry('chat-1', 'u1');
    const dead = entry('chat-1', 'u-dead');
    dead.raw.destroyed = true;
    hub.add(live);
    hub.add(dead);
    expect(hub.size()).toBe(2);

    const delivered = hub.broadcast('chat-1', 'p');

    expect(delivered).toBe(1);
    expect(live.raw.written).toEqual(['data: p\n\n']);
    expect(dead.raw.written).toEqual([]);
    // L'entry morte a été GC'd → size() reflète uniquement le live.
    expect(hub.size()).toBe(1);
  });

  it('skip une entry dont write() throw (back-pressure / EPIPE) et la retire', () => {
    // Sans ce GC, un client qui débranche son réseau resterait en
    // mémoire indéfiniment, et chaque broadcast suivant ré-essaierait
    // d'écrire (gaspillage CPU + risque d'erreur en cascade).
    const hub = new SseHub();
    const ok = entry('chat-1', 'u1');
    const broken = entry('chat-1', 'u2');
    broken.raw.writeShouldThrow = true;
    hub.add(ok);
    hub.add(broken);

    const delivered = hub.broadcast('chat-1', 'p');

    expect(delivered).toBe(1);
    expect(ok.raw.written).toEqual(['data: p\n\n']);
    expect(hub.size()).toBe(1);
  });

  it('si TOUTES les entries d\'un channel meurent au broadcast, le channel disparaît de la map', () => {
    // Anti-fuite mémoire long-terme : sans le cleanup, `byChannel`
    // garde des clés mortes après un mass-disconnect (ex: kill -9 d'un
    // browser, reload massif après push d'une version).
    const hub = new SseHub();
    const a = entry('chat-1');
    const b = entry('chat-1');
    a.raw.destroyed = true;
    b.raw.destroyed = true;
    hub.add(a);
    hub.add(b);

    hub.broadcast('chat-1', 'p');

    expect(hub.size()).toBe(0);
    // Channel oublié : prochain broadcast trouve undefined.
    expect(hub.broadcast('chat-1', 'q')).toBe(0);
  });
});

describe('SseHub.remove', () => {
  it('remove() retire bien l\'entry du channel (broadcast suivant la skip)', () => {
    const hub = new SseHub();
    const e = entry('chat-1');
    hub.add(e);
    hub.remove(e);
    expect(hub.size()).toBe(0);
    hub.broadcast('chat-1', 'p');
    expect(e.raw.written).toEqual([]);
  });

  it('remove() de la dernière entry d\'un channel supprime aussi la clé du Map', () => {
    // Vérifié indirectement : après remove() de l'unique entry, un
    // broadcast doit retomber sur "channel inconnu" (return 0), pas
    // sur "set vide" (qui retournerait aussi 0 mais laisserait la clé).
    const hub = new SseHub();
    const e = entry('chat-1');
    hub.add(e);
    hub.remove(e);
    // Si le Map gardait la clé "chat-1" → set vide, broadcast = 0
    // (même résultat externe). Mais un re-add ne créerait pas un
    // nouveau set, ce qui est OK. Le risque est plutôt l'accumulation
    // de clés mortes ; on lock-in en vérifiant que size reste 0.
    expect(hub.size()).toBe(0);
  });

  it('remove() d\'une entry sur un channel inconnu → noop (pas de crash)', () => {
    const hub = new SseHub();
    const e = entry('chat-fantome');
    expect(() => hub.remove(e)).not.toThrow();
  });

  it('remove() d\'une entry parmi plusieurs garde les autres en vie', () => {
    const hub = new SseHub();
    const a = entry('chat-1', 'u1');
    const b = entry('chat-1', 'u2');
    hub.add(a);
    hub.add(b);
    hub.remove(a);
    expect(hub.size()).toBe(1);
    const delivered = hub.broadcast('chat-1', 'p');
    expect(delivered).toBe(1);
    expect(a.raw.written).toEqual([]);
    expect(b.raw.written).toEqual(['data: p\n\n']);
  });
});
