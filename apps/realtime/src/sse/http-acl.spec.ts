import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpConversationAcl } from './http-acl';

// Mêmes contraintes fail-closed que HttpFederatedSubjectResolver : toute
// anomalie doit produire `false`. Un 403 spurieux est acceptable, une fuite
// ne l'est pas.
describe('HttpConversationAcl', () => {
  const BASE = 'http://edge-api:3000';
  const SECRET = 's'.repeat(32);
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('retourne true quand edge-api confirme canRead:true', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { canRead: true }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(true);
  });

  it('envoie le secret partagé en header x-internal-secret', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { canRead: true }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    await acl.canRead('u1', 'c1');
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      'x-internal-secret': SECRET,
    });
  });

  it('encode userId et conversationId dans l\'URL', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { canRead: true }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    await acl.canRead('u/1 with space', 'c?evil&id');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      `${BASE}/internal/conversations/c%3Fevil%26id/can-read` +
        `?userId=u%2F1%20with%20space`,
    );
  });

  it('renvoie false quand canRead vaut explicitement false', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { canRead: false }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false quand canRead est absent du body', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false quand canRead n\'est pas un booléen strict', async () => {
    // Garde-fou contre une réponse "truthy" — on n'accepte que `true`.
    fetchSpy.mockResolvedValue(jsonResponse(200, { canRead: 'true' }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false sur une 403', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false sur une 5xx', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false quand fetch lève (réseau KO, timeout)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });

  it('renvoie false quand le body 200 est du JSON invalide', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const acl = new HttpConversationAcl(BASE, SECRET);
    expect(await acl.canRead('u1', 'c1')).toBe(false);
  });
});
