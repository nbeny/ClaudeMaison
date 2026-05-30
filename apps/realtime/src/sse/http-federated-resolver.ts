import type { FederatedSubjectResolver } from '../auth';

/**
 * Client HTTP appelant edge-api
 * `/internal/auth/users/by-federated-subject?provider=…&subject=…`
 * pour mapper le subject Keycloak vers un userId local après vérification
 * RS256 du token. Sans ce mapping on appellerait l'ACL avec un identifiant
 * inconnu d'auth.users et le SSE renverrait 403 systématiquement.
 *
 * En cas d'erreur réseau ou de réponse non-2xx, on renvoie `null` ; le
 * caller (`TokenVerifier`) traduit ça en `Aucune identité fédérée`. Même
 * principe fail-closed que `HttpConversationAcl`.
 */
export class HttpFederatedSubjectResolver implements FederatedSubjectResolver {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async resolve(provider: string, subject: string): Promise<string | null> {
    const url =
      `${this.baseUrl}/internal/auth/users/by-federated-subject` +
      `?provider=${encodeURIComponent(provider)}` +
      `&subject=${encodeURIComponent(subject)}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'x-internal-secret': this.secret },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return null;
    }
    if (!resp.ok) return null;
    try {
      const body = (await resp.json()) as { userId?: unknown };
      return typeof body.userId === 'string' ? body.userId : null;
    } catch {
      return null;
    }
  }
}
