import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../config/env';
import { OidcDiscoveryService } from './oidc-discovery.service';

// OidcDiscoveryService est instancié au boot via OidcModule. Si le
// document discovery est inaccessible ou malformé, on doit échouer en
// `onModuleInit` (donc avant readiness) plutôt qu'à la première
// verification de token. Ces tests verrouillent :
//  - les guards du constructor (sans config = pas d'instanciation),
//  - la construction de l'URL discovery (trailing slash strippé),
//  - la validation stricte des 4 champs requis,
//  - les guards `getMetadata`/`getJwks` pré-load (pas d'usage avant boot).

const ISSUER = 'http://keycloak:8080/realms/claudemaison';
const CLIENT_ID = 'edge-api';

function makeConfig(values: Partial<Record<string, unknown>>): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService<Env, true>;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fullDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    ...overrides,
  };
}

describe('OidcDiscoveryService — constructor', () => {
  it('refuse de s\'instancier sans OIDC_ISSUER_URL', () => {
    const config = makeConfig({ OIDC_CLIENT_ID: CLIENT_ID });
    expect(() => new OidcDiscoveryService(config)).toThrow(/config OIDC/);
  });

  it('refuse de s\'instancier sans OIDC_CLIENT_ID', () => {
    const config = makeConfig({ OIDC_ISSUER_URL: ISSUER });
    expect(() => new OidcDiscoveryService(config)).toThrow(/config OIDC/);
  });
});

describe('OidcDiscoveryService — pre-load guards', () => {
  it('getMetadata() lève tant que onModuleInit n\'a pas chargé', () => {
    const svc = new OidcDiscoveryService(
      makeConfig({ OIDC_ISSUER_URL: ISSUER, OIDC_CLIENT_ID: CLIENT_ID }),
    );
    // Sans ce guard, un appel précoce renverrait `undefined` et casserait
    // silencieusement la première redirection vers l'IdP.
    expect(() => svc.getMetadata()).toThrow(/pas encore chargée/);
  });

  it('getJwks() lève tant que onModuleInit n\'a pas chargé', () => {
    const svc = new OidcDiscoveryService(
      makeConfig({ OIDC_ISSUER_URL: ISSUER, OIDC_CLIENT_ID: CLIENT_ID }),
    );
    expect(() => svc.getJwks()).toThrow(/pas encore initialisé/);
  });
});

describe('OidcDiscoveryService.onModuleInit — fetch & validation', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeSvc(): OidcDiscoveryService {
    return new OidcDiscoveryService(
      makeConfig({ OIDC_ISSUER_URL: ISSUER, OIDC_CLIENT_ID: CLIENT_ID }),
    );
  }

  it('appelle l\'URL discovery construite depuis l\'issuer', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc()));
    await makeSvc().onModuleInit();

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect((init as RequestInit).headers).toMatchObject({
      Accept: 'application/json',
    });
  });

  it('strippe le trailing slash sur l\'issuer (sinon URL avec //.well-known)', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc()));
    const svc = new OidcDiscoveryService(
      makeConfig({ OIDC_ISSUER_URL: `${ISSUER}/`, OIDC_CLIENT_ID: CLIENT_ID }),
    );
    await svc.onModuleInit();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('lève une erreur incluant le code HTTP sur 4xx', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not found', { status: 404, statusText: 'Not Found' }),
    );
    await expect(makeSvc().onModuleInit()).rejects.toThrow(/404/);
  });

  it('lève une erreur incluant le code HTTP sur 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(makeSvc().onModuleInit()).rejects.toThrow(/503/);
  });

  it.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)(
    'lève si le champ requis "%s" est absent',
    async (field) => {
      const doc = fullDoc();
      delete doc[field];
      fetchSpy.mockResolvedValue(jsonOk(doc));
      await expect(makeSvc().onModuleInit()).rejects.toThrow(new RegExp(field));
    },
  );

  it.each(['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)(
    'lève si le champ requis "%s" est du mauvais type',
    async (field) => {
      fetchSpy.mockResolvedValue(jsonOk(fullDoc({ [field]: 42 })));
      await expect(makeSvc().onModuleInit()).rejects.toThrow(new RegExp(field));
    },
  );

  it('charge metadata après succès et expose les 4 champs requis', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc()));
    const svc = makeSvc();
    await svc.onModuleInit();

    const meta = svc.getMetadata();
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorizationEndpoint).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(meta.tokenEndpoint).toBe(`${ISSUER}/protocol/openid-connect/token`);
    expect(meta.jwksUri).toBe(`${ISSUER}/protocol/openid-connect/certs`);
  });

  it('expose end_session_endpoint quand fourni (logout SLO côté IdP)', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc()));
    const svc = makeSvc();
    await svc.onModuleInit();
    expect(svc.getMetadata().endSessionEndpoint).toBe(
      `${ISSUER}/protocol/openid-connect/logout`,
    );
  });

  it('end_session_endpoint reste undefined si IdP ne le fournit pas', async () => {
    const doc = fullDoc();
    delete doc.end_session_endpoint;
    fetchSpy.mockResolvedValue(jsonOk(doc));
    const svc = makeSvc();
    await svc.onModuleInit();
    expect(svc.getMetadata().endSessionEndpoint).toBeUndefined();
  });

  it('end_session_endpoint ignoré si type incorrect (sans throw, car optionnel)', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc({ end_session_endpoint: 42 })));
    const svc = makeSvc();
    await svc.onModuleInit();
    expect(svc.getMetadata().endSessionEndpoint).toBeUndefined();
  });

  it('getJwks() retourne une fonction après chargement (JWTVerifyGetKey)', async () => {
    fetchSpy.mockResolvedValue(jsonOk(fullDoc()));
    const svc = makeSvc();
    await svc.onModuleInit();
    expect(typeof svc.getJwks()).toBe('function');
  });
});
