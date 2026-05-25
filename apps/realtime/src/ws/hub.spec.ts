import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnectionHub } from './hub';

// Fake WebSocket minimal : on n'a besoin que de readyState + send + OPEN const.
function fakeSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  const s = {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    sent,
  };
  return s as unknown as WebSocket & { sent: string[] };
}

describe('ConnectionHub', () => {
  it('broadcaste à toutes les sockets d’un channel', () => {
    const hub = new ConnectionHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.add({ userId: 'u1', channel: 'chat-1', socket: a });
    hub.add({ userId: 'u2', channel: 'chat-1', socket: b });

    const delivered = hub.broadcast('chat-1', '{"hello":"world"}');

    expect(delivered).toBe(2);
    expect(a.sent).toEqual(['{"hello":"world"}']);
    expect(b.sent).toEqual(['{"hello":"world"}']);
  });

  it('n’envoie qu’au channel ciblé', () => {
    const hub = new ConnectionHub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.add({ userId: 'u1', channel: 'chat-1', socket: a });
    hub.add({ userId: 'u2', channel: 'chat-2', socket: b });

    hub.broadcast('chat-1', 'payload');

    expect(a.sent).toEqual(['payload']);
    expect(b.sent).toEqual([]);
  });

  it('ignore les sockets fermées', () => {
    const hub = new ConnectionHub();
    const a = fakeSocket();
    // CLOSED — on bypass le readonly du type officiel parce que c'est un fake.
    (a as unknown as { readyState: number }).readyState = 3;
    hub.add({ userId: 'u1', channel: 'chat-1', socket: a });

    const delivered = hub.broadcast('chat-1', 'payload');

    expect(delivered).toBe(0);
    expect(a.sent).toEqual([]);
  });

  it('remove() supprime du channel et nettoie l’entrée vide', () => {
    const hub = new ConnectionHub();
    const a = fakeSocket();
    const entry = { userId: 'u1', channel: 'chat-1', socket: a };
    hub.add(entry);
    expect(hub.size()).toBe(1);

    hub.remove(entry);
    expect(hub.size()).toBe(0);
    expect(hub.broadcast('chat-1', 'x')).toBe(0);
  });
});
