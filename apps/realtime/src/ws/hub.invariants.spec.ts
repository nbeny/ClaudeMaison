import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { ConnectionHub } from './hub';

// Caractérisation invariants subtils ConnectionHub (ws/hub).
//
// hub.spec.ts couvre 4 happy paths (broadcast multi, channel isolation,
// skip closed, remove cleanup). Ce fichier verrouille les invariants
// silencieux dont la régression dégrade le fan-out sans crash visible.
//
//   - **add() préserve les entrées existantes du channel** : la ligne
//     `set.get(channel) ?? new Set()` est CRITIQUE. Si quelqu'un refactor
//     en `set.set(channel, new Set([entry]))`, le 2e add wipe le 1er →
//     fuite de connexion silencieuse côté pod (la socket reste ouverte
//     mais ne reçoit plus rien).
//
//   - **Channel auto-cleanup quand set vide** : sinon, chaque channel
//     éphémère leak une Map entry. Pour un chat avec 100k conversations
//     uniques, on garde 100k Map entries indéfiniment → leak mémoire.
//
//   - **broadcast() filtre par readyState === OPEN STRICT** :
//     CONNECTING (0), CLOSING (2), CLOSED (3) sont TOUS skip. Le test
//     existant ne couvre que CLOSED. Si on remplaçait par `!== CLOSED`,
//     un send() pendant CLOSING throw async (post-FIN frame).
//
//   - **broadcast() retourne le count précis des sockets OPEN** : si on
//     incrémentait toujours, l'instrumentation OTel rapporterait des
//     deliveries fantômes pour le monitoring du fan-out.
//
//   - **Set utilise égalité par référence** : deux objets avec mêmes
//     valeurs sont DEUX entries distinctes. Conséquence : on peut avoir
//     la MÊME socket ws inscrite 2 fois (par 2 entries) et elle recevra
//     2 copies — c'est intentionnel (un user peut ouvrir 2 onglets sur
//     le même channel).
//
//   - **remove(unknown channel) = no-op** : pas de throw. Le caller du
//     "ws close" handler ne sait pas si add a été appelé. Si remove
//     throwait, on cascaderait en uncaught error sur disconnect.
//
//   - **remove(unknown entry depuis channel known) = no-op silencieux** :
//     Set.delete renvoie false ; on n'inspecte pas. Idempotent.
//
//   - **size() somme bien à travers les channels** : pas juste count par
//     channel ni nombre de channels. Crucial pour le metric global
//     "active_ws_connections" exposé par le pod.
//
//   - **Re-add après cleanup recrée le channel proprement** : critique
//     pour les channels short-lived (conversation éphémère ouverte/fermée
//     en boucle).

type FakeSocket = WebSocket & { sent: string[] };

function fakeSocket(readyState = 1): FakeSocket {
  const sent: string[] = [];
  const s = {
    OPEN: 1,
    readyState,
    send: vi.fn((data: string) => sent.push(data)),
    sent,
  };
  return s as unknown as FakeSocket;
}

// Helpers pour explorer l'état interne sans casser l'encapsulation.
function channelExists(hub: ConnectionHub, channel: string): boolean {
  // Probe via broadcast : si le channel existe (même vide), broadcast
  // retourne 0 mais ne touche pas l'état. Mais on ne peut pas
  // distinguer "channel absent" de "channel vide" par cette voie...
  // donc on utilise la sortie de size() = 0 + un add temporaire.
  // Mieux : check via Map interne (acceptable en test car friend access).
  return (hub as unknown as { byChannel: Map<string, unknown> }).byChannel.has(channel);
}

describe('ConnectionHub.add — préservation du set existant', () => {
  it('un 2e add sur le même channel n\'écrase PAS la 1re entrée', async () => {
    // Si quelqu'un refactor en `set.set(channel, new Set([entry]))`,
    // le 1er add est wiped → fuite silencieuse côté pod.
    const hub = new ConnectionHub();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    hub.add({ userId: 'u1', channel: 'chat-1', socket: s1 });
    hub.add({ userId: 'u2', channel: 'chat-1', socket: s2 });

    expect(hub.size()).toBe(2);
    const delivered = hub.broadcast('chat-1', 'msg');
    expect(delivered).toBe(2);
    expect(s1.sent).toEqual(['msg']);
    expect(s2.sent).toEqual(['msg']);
  });

  it('5 adds successifs sur le même channel produisent 5 entries', async () => {
    const hub = new ConnectionHub();
    const sockets = Array.from({ length: 5 }, () => fakeSocket());
    for (const s of sockets) {
      hub.add({ userId: 'u', channel: 'chat', socket: s });
    }
    expect(hub.size()).toBe(5);
    expect(hub.broadcast('chat', 'x')).toBe(5);
  });
});

describe('ConnectionHub.remove — cleanup et tolérance', () => {
  it('cleanup le channel quand son set devient vide (anti-leak)', async () => {
    const hub = new ConnectionHub();
    const entry = { userId: 'u', channel: 'eph', socket: fakeSocket() };
    hub.add(entry);
    expect(channelExists(hub, 'eph')).toBe(true);
    hub.remove(entry);
    // Le channel doit avoir DISPARU de la Map interne, sinon on a un
    // leak pour chaque conversation éphémère.
    expect(channelExists(hub, 'eph')).toBe(false);
  });

  it('ne cleanup PAS le channel s\'il reste des entries', async () => {
    const hub = new ConnectionHub();
    const e1 = { userId: 'u1', channel: 'chat', socket: fakeSocket() };
    const e2 = { userId: 'u2', channel: 'chat', socket: fakeSocket() };
    hub.add(e1);
    hub.add(e2);
    hub.remove(e1);
    expect(channelExists(hub, 'chat')).toBe(true);
    expect(hub.size()).toBe(1);
  });

  it('remove sur channel inconnu = no-op silencieux (pas de throw)', async () => {
    // Le handler "ws close" appelle remove sans savoir si add a réussi.
    // Si remove throwait, on cascaderait en uncaught.
    const hub = new ConnectionHub();
    const phantom = { userId: 'u', channel: 'ghost', socket: fakeSocket() };
    expect(() => hub.remove(phantom)).not.toThrow();
    expect(hub.size()).toBe(0);
  });

  it('remove sur entry inconnue depuis un channel existant = no-op idempotent', async () => {
    const hub = new ConnectionHub();
    const real = { userId: 'u1', channel: 'chat', socket: fakeSocket() };
    const phantom = { userId: 'u2', channel: 'chat', socket: fakeSocket() };
    hub.add(real);
    expect(() => hub.remove(phantom)).not.toThrow();
    expect(hub.size()).toBe(1);  // real toujours là
  });

  it('remove appelé 2x sur la même entry = idempotent', async () => {
    const hub = new ConnectionHub();
    const entry = { userId: 'u', channel: 'chat', socket: fakeSocket() };
    hub.add(entry);
    hub.remove(entry);
    expect(() => hub.remove(entry)).not.toThrow();
    expect(hub.size()).toBe(0);
  });

  it('add → remove → add recrée le channel proprement', async () => {
    // Pattern usage : channel éphémère re-ouvert plusieurs fois.
    // Le cleanup ne doit pas laisser d'état latent qui casse le re-add.
    const hub = new ConnectionHub();
    const e1 = { userId: 'u', channel: 'eph', socket: fakeSocket() };
    hub.add(e1);
    hub.remove(e1);
    expect(channelExists(hub, 'eph')).toBe(false);

    const e2 = { userId: 'u', channel: 'eph', socket: fakeSocket() };
    hub.add(e2);
    expect(channelExists(hub, 'eph')).toBe(true);
    expect(hub.broadcast('eph', 'recovered')).toBe(1);
  });
});

describe('ConnectionHub.broadcast — readyState filtering strict', () => {
  // L'enum WebSocket readyState officiel :
  // CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3.
  // Seul OPEN doit recevoir send().

  it('skip CONNECTING (readyState=0) : pas d\'envoi avant handshake fini', async () => {
    // send() sur CONNECTING throw (RFC). Le hub doit le filtrer en amont.
    const hub = new ConnectionHub();
    const s = fakeSocket(0);
    hub.add({ userId: 'u', channel: 'chat', socket: s });
    expect(hub.broadcast('chat', 'x')).toBe(0);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('skip CLOSING (readyState=2) : déjà en cours de FIN', async () => {
    // CLOSING signifie qu'on a envoyé un close frame mais pas reçu le
    // ack. Continuer à push des messages = ECONNRESET async garanti.
    const hub = new ConnectionHub();
    const s = fakeSocket(2);
    hub.add({ userId: 'u', channel: 'chat', socket: s });
    expect(hub.broadcast('chat', 'x')).toBe(0);
    expect(s.send).not.toHaveBeenCalled();
  });

  it('skip CLOSED (readyState=3) : socket déjà clean shutdown', async () => {
    const hub = new ConnectionHub();
    const s = fakeSocket(3);
    hub.add({ userId: 'u', channel: 'chat', socket: s });
    expect(hub.broadcast('chat', 'x')).toBe(0);
  });

  it('compte précis quand mix OPEN + CLOSED dans le même channel', async () => {
    // Si on incrémentait toujours, le métriques OTel "ws_messages_sent"
    // rapporterait du fan-out fantôme.
    const hub = new ConnectionHub();
    const openA = fakeSocket(1);
    const closed = fakeSocket(3);
    const openB = fakeSocket(1);
    hub.add({ userId: 'u1', channel: 'chat', socket: openA });
    hub.add({ userId: 'u2', channel: 'chat', socket: closed });
    hub.add({ userId: 'u3', channel: 'chat', socket: openB });

    const delivered = hub.broadcast('chat', 'msg');
    expect(delivered).toBe(2);
    expect(openA.sent).toEqual(['msg']);
    expect(closed.sent).toEqual([]);
    expect(openB.sent).toEqual(['msg']);
  });

  it('broadcast sur channel inconnu retourne 0 sans throw', async () => {
    const hub = new ConnectionHub();
    expect(hub.broadcast('nope', 'x')).toBe(0);
  });
});

describe('ConnectionHub — set par référence (anti-déduplication par valeur)', () => {
  it('deux entries avec mêmes valeurs mais sockets distincts = 2 deliveries', async () => {
    // Cas usage : même user, même channel, 2 onglets différents.
    // Chaque onglet a son propre WebSocket → 2 entries distincts.
    const hub = new ConnectionHub();
    const tab1 = fakeSocket();
    const tab2 = fakeSocket();
    hub.add({ userId: 'u1', channel: 'chat', socket: tab1 });
    hub.add({ userId: 'u1', channel: 'chat', socket: tab2 });
    expect(hub.size()).toBe(2);
    expect(hub.broadcast('chat', 'x')).toBe(2);
  });

  it('la MÊME socket ajoutée 2 fois (mêmes objets entry) = 1 entry (Set dedupe par référence)', async () => {
    // Cas pathologique : add(entry) puis add(entry) avec le même
    // objet → Set.add() le dedupe par référence d'objet. Cette
    // caractéristique est ce qui rend remove(entry) idempotent.
    const hub = new ConnectionHub();
    const s = fakeSocket();
    const entry = { userId: 'u', channel: 'chat', socket: s };
    hub.add(entry);
    hub.add(entry);
    expect(hub.size()).toBe(1);
    expect(hub.broadcast('chat', 'x')).toBe(1);
    expect(s.sent).toEqual(['x']);  // pas dupliqué
  });
});

describe('ConnectionHub.size — agrégation multi-channels', () => {
  it('somme bien à travers les channels distincts', async () => {
    const hub = new ConnectionHub();
    hub.add({ userId: 'u', channel: 'c1', socket: fakeSocket() });
    hub.add({ userId: 'u', channel: 'c2', socket: fakeSocket() });
    hub.add({ userId: 'u', channel: 'c2', socket: fakeSocket() });
    hub.add({ userId: 'u', channel: 'c3', socket: fakeSocket() });
    // 1 + 2 + 1 = 4. Pas 3 (channels), pas 1 (par channel).
    expect(hub.size()).toBe(4);
  });

  it('retourne 0 sur hub vide', async () => {
    expect(new ConnectionHub().size()).toBe(0);
  });
});

describe('ConnectionHub — isolation des channels au broadcast', () => {
  it('broadcast vers un channel n\'envoie RIEN aux sockets d\'un autre channel', async () => {
    // Existant : 'n’envoie qu’au channel ciblé' fait sa job mais ne
    // couvre que 2 channels. Verrouillons 3 channels pour anti-régression
    // sur un éventuel "broadcast to all".
    const hub = new ConnectionHub();
    const a = fakeSocket();
    const b = fakeSocket();
    const c = fakeSocket();
    hub.add({ userId: 'u', channel: 'c1', socket: a });
    hub.add({ userId: 'u', channel: 'c2', socket: b });
    hub.add({ userId: 'u', channel: 'c3', socket: c });

    hub.broadcast('c2', 'only-c2');
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual(['only-c2']);
    expect(c.sent).toEqual([]);
  });
});
