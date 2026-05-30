import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpFederatedSubjectResolver } from './http-federated-resolver';

// Le client est volontairement fail-closed : toute anomalie (réseau,
// non-2xx, body invalide) doit produire `null`. Ces tests verrouillent
// cette sémantique pour qu'un refactor "amélioré" ne réintroduise pas
// d'auto-fallback accidentel.
describe('HttpFederatedSubjectResolver', () => {
  const BASE = 'http://edge-api:3000';
  const SECRET = 's'.repeat(32);
  // `vi.spyOn(globalThis, 'fetch')` traîne les overloads de fetch et casse
  // l'inférence côté TS — on stub globalement à la place.
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

  it('retourne userId quand edge-api répond 200 avec un userId string', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { userId: 'local-user-alice' }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    const out = await resolver.resolve('oidc', 'kc-sub-alice');
    expect(out).toBe('local-user-alice');
  });

  it('envoie le secret partagé en header x-internal-secret', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { userId: 'u1' }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    await resolver.resolve('oidc', 'kc-sub-alice');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      'x-internal-secret': SECRET,
    });
  });

  it('encode provider et subject dans la query string', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { userId: 'u1' }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    await resolver.resolve('oidc', 'kc sub/with&special?chars');

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      `${BASE}/internal/auth/users/by-federated-subject` +
        `?provider=oidc&subject=kc%20sub%2Fwith%26special%3Fchars`,
    );
  });

  it('renvoie null si edge-api répond 404 (identité fédérée absente)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { error: 'not found' }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    expect(await resolver.resolve('oidc', 'unknown')).toBeNull();
  });

  it('renvoie null sur une 5xx', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    expect(await resolver.resolve('oidc', 'kc-sub-alice')).toBeNull();
  });

  it('renvoie null quand fetch lève (réseau KO, timeout)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    expect(await resolver.resolve('oidc', 'kc-sub-alice')).toBeNull();
  });

  it('renvoie null quand le body 200 est du JSON invalide', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    expect(await resolver.resolve('oidc', 'kc-sub-alice')).toBeNull();
  });

  it('renvoie null quand le body 200 n\'expose pas un userId string', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { userId: 42 }));
    const resolver = new HttpFederatedSubjectResolver(BASE, SECRET);
    expect(await resolver.resolve('oidc', 'kc-sub-alice')).toBeNull();
  });
});
