import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TokenVerifier } from '../auth';
import type { ConnectionHub, HubEntry } from './hub';

interface WsQuery {
  token?: string;
  channel?: string;
}

// /ws/v1/stream?token=<jwt>&channel=<id>
//
// On préfère le query token plutôt qu'un header parce que l'API WebSocket
// du navigateur ne permet pas de passer de headers custom à l'upgrade.
// Mitigations : token short-lived (TTL access edge-api), TLS obligatoire en
// prod, accès loggé sans payload, expiration côté serveur applique le sid.
export function registerWsRoutes(
  app: FastifyInstance,
  deps: { verifier: TokenVerifier; hub: ConnectionHub },
): void {
  app.get('/ws/v1/stream', { websocket: true }, async (socket, req) => {
    const { token, channel } = (req as FastifyRequest<{ Querystring: WsQuery }>).query;

    if (!token || !channel) {
      socket.close(1008, 'missing token or channel');
      return;
    }

    let claims;
    try {
      claims = await deps.verifier.verify(token);
    } catch (err) {
      req.log.warn({ err }, 'ws auth rejected');
      socket.close(1008, 'auth rejected');
      return;
    }

    // TODO: vérifier que l'utilisateur a accès au channel. Pour l'instant on
    // n'a pas d'API d'autorisation côté realtime ; on accepte tout channel
    // une fois le JWT validé. Sera branché sur edge-api gRPC (ACL workspace)
    // quand la surface sera stabilisée.

    const entry: HubEntry = { userId: claims.sub, channel, socket };
    deps.hub.add(entry);

    socket.on('close', () => deps.hub.remove(entry));
    socket.on('error', (err: Error) => {
      req.log.warn({ err, userId: claims.sub, channel }, 'ws socket error');
    });

    socket.send(JSON.stringify({ type: 'subscribed', channel }));
  });
}
