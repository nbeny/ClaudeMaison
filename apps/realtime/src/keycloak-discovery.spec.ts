import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverKeycloak } from './keycloak-discovery';

// `discoverKeycloak` est appelé au boot (main.ts) — un échec ici doit
// faire planter le pod, pas dériver vers une vérif token muette. Ces tests
// figent la forme des erreurs et l'URL construite.
describe('discoverKeycloak', () => {
  const ISSUER = 'http://keycloak:8080/realms/claudemaison-dev';
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonOk(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it("appelle l'URL discovery construite à partir de l'issuer", async () => {
    fetchSpy.mockResolvedValue(
      jsonOk({ issuer: ISSUER, jwks_uri: `${ISSUER}/protocol/openid-connect/certs` }),
    );

    await discoverKeycloak(ISSUER);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect((init as RequestInit).headers).toMatchObject({
      Accept: 'application/json',
    });
  });

  it('strippe le trailing slash sur l\'issuer fourni', async () => {
    fetchSpy.mockResolvedValue(
      jsonOk({ issuer: ISSUER, jwks_uri: `${ISSUER}/protocol/openid-connect/certs` }),
    );

    await discoverKeycloak(`${ISSUER}/`);

    const [url] = fetchSpy.mock.calls[0]!;
    // Pas de `//.well-known/...` — ça génère un 404 chez Keycloak.
    expect(String(url)).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('retourne { issuer, jwks } quand le document est bien formé', async () => {
    fetchSpy.mockResolvedValue(
      jsonOk({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      }),
    );

    const out = await discoverKeycloak(ISSUER);

    expect(out.issuer).toBe(ISSUER);
    // jose.createRemoteJWKSet retourne une fonction (JWTVerifyGetKey).
    expect(typeof out.jwks).toBe('function');
  });

  it('lève une erreur informative sur 404', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(discoverKeycloak(ISSUER)).rejects.toThrow(/404/);
  });

  it('lève une erreur informative sur 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(discoverKeycloak(ISSUER)).rejects.toThrow(/503/);
  });

  it('lève si le document discovery ne contient pas d\'issuer', async () => {
    fetchSpy.mockResolvedValue(
      jsonOk({ jwks_uri: `${ISSUER}/protocol/openid-connect/certs` }),
    );
    await expect(discoverKeycloak(ISSUER)).rejects.toThrow(/issuer/);
  });

  it('lève si le document discovery ne contient pas de jwks_uri', async () => {
    fetchSpy.mockResolvedValue(jsonOk({ issuer: ISSUER }));
    await expect(discoverKeycloak(ISSUER)).rejects.toThrow(/jwks_uri/);
  });

  it('lève si issuer/jwks_uri sont du mauvais type (ex: number)', async () => {
    fetchSpy.mockResolvedValue(jsonOk({ issuer: 42, jwks_uri: null }));
    await expect(discoverKeycloak(ISSUER)).rejects.toThrow();
  });
});
