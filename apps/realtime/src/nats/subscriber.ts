import { connect, type NatsConnection, StringCodec } from 'nats';

// Souscription minimale : on suit `events.<channel>` et on broadcaste à
// toutes les sockets du channel correspondant. Pas de JetStream ack ici —
// on est en best-effort delivery, c'est OK pour des évènements UI
// (rejouables côté ai-core si manqués). Quand on aura besoin de garanties
// (ex: paiement WS), on basculera sur JetStream consumer durable par user.

export interface Broadcastable {
  broadcast(channel: string, payload: string): number;
}

export class NatsSubscriber {
  private connection: NatsConnection | null = null;
  private readonly codec = StringCodec();

  constructor(
    private readonly url: string,
    private readonly hubs: readonly Broadcastable[],
    private readonly log: (msg: string, extra?: object) => void,
  ) {}

  async start(): Promise<void> {
    this.connection = await connect({ servers: this.url });
    this.log(`nats connected → ${this.url}`);

    const sub = this.connection.subscribe('events.>');
    (async () => {
      for await (const m of sub) {
        // Sujet attendu : events.<channelId>
        const channel = m.subject.slice('events.'.length);
        const payload = this.codec.decode(m.data);
        for (const h of this.hubs) {
          try {
            h.broadcast(channel, payload);
          } catch (err) {
            this.log('hub broadcast failed', { err: String(err), channel });
          }
        }
      }
    })().catch((err) => {
      this.log('nats subscription loop crashed', { err: String(err) });
    });
  }

  async stop(): Promise<void> {
    if (!this.connection) return;
    await this.connection.drain();
    this.connection = null;
  }
}
