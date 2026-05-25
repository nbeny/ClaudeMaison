import type { WebSocket } from 'ws';

// Hub minimaliste : indexe les sockets actifs par (userId, channel). Quand
// un message NATS arrive sur un sujet `events.<channel>`, on broadcaste à
// toutes les sockets du channel qui appartiennent à un user autorisé.
//
// Choix architectural : le hub vit dans le process ; pas de partage entre
// pods. La couche NATS est la fan-out — chaque pod realtime reçoit tous les
// messages et filtre ses propres clients. C'est correct jusqu'à ~10k
// connexions par pod ; au-delà on sharde par channel sur des sujets NATS
// distincts.

export interface HubEntry {
  userId: string;
  channel: string;
  socket: WebSocket;
}

export class ConnectionHub {
  private readonly byChannel = new Map<string, Set<HubEntry>>();

  add(entry: HubEntry): void {
    const set = this.byChannel.get(entry.channel) ?? new Set<HubEntry>();
    set.add(entry);
    this.byChannel.set(entry.channel, set);
  }

  remove(entry: HubEntry): void {
    const set = this.byChannel.get(entry.channel);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) this.byChannel.delete(entry.channel);
  }

  broadcast(channel: string, payload: string): number {
    const set = this.byChannel.get(channel);
    if (!set) return 0;
    let delivered = 0;
    for (const entry of set) {
      if (entry.socket.readyState === entry.socket.OPEN) {
        entry.socket.send(payload);
        delivered++;
      }
    }
    return delivered;
  }

  size(): number {
    let total = 0;
    for (const set of this.byChannel.values()) total += set.size;
    return total;
  }
}
