import type { FastifyReply } from 'fastify';

export interface SseEntry {
  userId: string;
  channel: string;
  reply: FastifyReply;
}

export class SseHub {
  private readonly byChannel = new Map<string, Set<SseEntry>>();

  add(entry: SseEntry): void {
    const set = this.byChannel.get(entry.channel) ?? new Set<SseEntry>();
    set.add(entry);
    this.byChannel.set(entry.channel, set);
  }

  remove(entry: SseEntry): void {
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
      entry.reply.raw.write(`data: ${payload}\n\n`);
      delivered++;
    }
    return delivered;
  }

  size(): number {
    let total = 0;
    for (const s of this.byChannel.values()) total += s.size;
    return total;
  }
}
