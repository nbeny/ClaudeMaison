import type { ConversationAcl } from './routes';

/**
 * Client HTTP appelant edge-api `/internal/conversations/:id/can-read` pour
 * vérifier qu'un user a le droit de lire les events d'une conversation
 * (avant d'ouvrir le SSE). Le secret partagé est passé en header
 * `x-internal-secret`.
 *
 * En cas d'erreur réseau ou de réponse non-2xx, on renvoie `false` —
 * fail-closed est volontaire : mieux vaut un 403 spurious qu'une fuite.
 */
export class HttpConversationAcl implements ConversationAcl {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async canRead(userId: string, conversationId: string): Promise<boolean> {
    const url =
      `${this.baseUrl}/internal/conversations/${encodeURIComponent(conversationId)}` +
      `/can-read?userId=${encodeURIComponent(userId)}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'x-internal-secret': this.secret },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return false;
    }
    if (!resp.ok) return false;
    try {
      const body = (await resp.json()) as { canRead?: unknown };
      return body.canRead === true;
    } catch {
      return false;
    }
  }
}
