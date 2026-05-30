import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../config/env';
import type { AuthService, IssuedTokens } from '../auth.service';
import { OidcController } from './oidc.controller';
import type { OidcDiscoveryService, OidcMetadata } from './oidc-discovery.service';
import type { OidcStateData, OidcStateStore } from './oidc-state.store';

// `jose.jwtVerify` est mocké pour driver les claims du ID token sans
// monter un IdP. Le contrôleur n'utilise que `jwtVerify` de jose.
const { jwtVerifyMock } = vi.hoisted(() => ({ jwtVerifyMock: vi.fn() }));
vi.mock('jose', () => ({ jwtVerify: jwtVerifyMock }));

// On se concentre sur la protection open-redirect via `sanitizeReturnTo` :
// c'est la seule logique métier de `login()` (le reste est de l'OAuth
// boilerplate). Un attaquant qui contrôle `returnTo` pourrait sinon
// récupérer les tokens du user au callback — ces tokens sont posés en
// fragment d'URL sur la destination finale.

const ALLOWED_ORIGIN = 'http://web.localhost';
const POST_LOGIN = `${ALLOWED_ORIGIN}/post-login`;

function makeConfig(): ConfigService<Env, true> {
  // Couvre les clés lues par le constructeur d'OidcController.
  const table: Record<string, unknown> = {
    OIDC_CLIENT_ID: 'client-id',
    OIDC_CLIENT_SECRET: 'client-secret',
    OIDC_REDIRECT_URI: 'http://edge-api/v1/auth/oidc/callback',
    OIDC_POST_LOGIN_REDIRECT: POST_LOGIN,
    ALLOWED_ORIGINS: [ALLOWED_ORIGIN],
  };
  return {
    get: vi.fn((key: string) => table[key]),
  } as unknown as ConfigService<Env, true>;
}

function makeDiscovery(): OidcDiscoveryService {
  const meta: OidcMetadata = {
    issuer: 'http://keycloak/realms/test',
    authorizationEndpoint: 'http://keycloak/realms/test/protocol/openid-connect/auth',
    tokenEndpoint: 'http://keycloak/realms/test/protocol/openid-connect/token',
    jwksUri: 'http://keycloak/realms/test/protocol/openid-connect/certs',
  };
  return {
    getMetadata: vi.fn().mockReturnValue(meta),
    getJwks: vi.fn(),
  } as unknown as OidcDiscoveryService;
}

function makeStateStore(): OidcStateStore & { put: ReturnType<typeof vi.fn> } {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(),
  } as unknown as OidcStateStore & { put: ReturnType<typeof vi.fn> };
}

function makeReply(): FastifyReply & { redirect: ReturnType<typeof vi.fn> } {
  return {
    redirect: vi.fn().mockResolvedValue(undefined),
  } as unknown as FastifyReply & { redirect: ReturnType<typeof vi.fn> };
}

const NOOP_AUTH = {} as AuthService;

describe('OidcController.login — sanitizeReturnTo (open-redirect guard)', () => {
  let store: ReturnType<typeof makeStateStore>;
  let reply: ReturnType<typeof makeReply>;
  let ctrl: OidcController;

  beforeEach(() => {
    store = makeStateStore();
    reply = makeReply();
    ctrl = new OidcController(makeConfig(), makeDiscovery(), store, NOOP_AUTH);
  });

  function storedReturnTo(): string | undefined {
    expect(store.put).toHaveBeenCalledTimes(1);
    const [, data] = store.put.mock.calls[0]! as [string, OidcStateData];
    return data.returnTo;
  }

  it('garde le returnTo intact quand l\'origine matche le post-login redirect', async () => {
    await ctrl.login(`${ALLOWED_ORIGIN}/dashboard`, reply);
    expect(storedReturnTo()).toBe(`${ALLOWED_ORIGIN}/dashboard`);
  });

  it('stocke returnTo=undefined quand returnTo n\'est pas fourni', async () => {
    await ctrl.login(undefined, reply);
    expect(storedReturnTo()).toBeUndefined();
  });

  it('rejette un returnTo d\'origine différente (cas open-redirect classique)', async () => {
    await ctrl.login('https://evil.example.com/steal', reply);
    expect(storedReturnTo()).toBeUndefined();
  });

  it('rejette un returnTo de même host mais autre scheme (http vs https)', async () => {
    // `Origin` inclut le scheme : `http://web.localhost` ≠ `https://web.localhost`.
    // Important : un attaquant ne doit pas pouvoir downgrade/upgrade le scheme.
    await ctrl.login('https://web.localhost/dashboard', reply);
    expect(storedReturnTo()).toBeUndefined();
  });

  it('rejette un returnTo avec scheme javascript: (XSS-via-redirect)', async () => {
    // `new URL('javascript:alert(1)')` parse, mais .origin === "null".
    await ctrl.login('javascript:alert(1)', reply);
    expect(storedReturnTo()).toBeUndefined();
  });

  it('rejette un returnTo qui n\'est pas une URL valide', async () => {
    await ctrl.login('not a url', reply);
    expect(storedReturnTo()).toBeUndefined();
  });

  it('rejette un returnTo protocol-relative //evil.com (origin null sur URL nue)', async () => {
    // Sans base, `new URL('//evil.com')` lève → returnTo=undefined.
    await ctrl.login('//evil.com/steal', reply);
    expect(storedReturnTo()).toBeUndefined();
  });
});

describe('OidcController.login — pipeline state + redirect', () => {
  let store: ReturnType<typeof makeStateStore>;
  let reply: ReturnType<typeof makeReply>;
  let ctrl: OidcController;

  beforeEach(() => {
    store = makeStateStore();
    reply = makeReply();
    ctrl = new OidcController(makeConfig(), makeDiscovery(), store, NOOP_AUTH);
  });

  it('stocke codeVerifier + nonce dans le state store avant de rediriger', async () => {
    await ctrl.login(undefined, reply);
    expect(store.put).toHaveBeenCalledTimes(1);
    const [stateKey, data] = store.put.mock.calls[0]! as [string, OidcStateData];
    expect(typeof stateKey).toBe('string');
    expect(stateKey.length).toBeGreaterThan(10);
    expect(typeof data.codeVerifier).toBe('string');
    expect(typeof data.nonce).toBe('string');
    expect(data.codeVerifier).not.toBe(data.nonce);
  });

  it('redirige vers authorization_endpoint avec PKCE S256 + state + nonce', async () => {
    await ctrl.login(undefined, reply);
    expect(reply.redirect).toHaveBeenCalledTimes(1);
    const [url, status] = reply.redirect.mock.calls[0]!;
    expect(status).toBe(302);

    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'http://keycloak/realms/test/protocol/openid-connect/auth',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(parsed.searchParams.get('nonce')).toBeTruthy();
    expect(parsed.searchParams.get('scope')).toBe('openid profile email');
  });
});

// ---------------------------------------------------------------------------
// Callback : on couvre les chemins de rejet (CSRF, replay, IdP mal configuré
// ou attaquant) et le happy path. L'enjeu principal : `email_verified=false`
// doit *toujours* être refusé sinon n'importe qui peut créer un compte à
// l'IdP avec l'email d'une victime non vérifié et squatter son compte local.
// ---------------------------------------------------------------------------

const FAKE_REQ = {
  headers: { 'user-agent': 'rt-test' },
  ip: '127.0.0.1',
} as unknown as FastifyRequest;

function makeStoredState(): OidcStateData {
  return {
    codeVerifier: 'verifier-xyz',
    nonce: 'nonce-abc',
    returnTo: undefined,
    createdAt: Date.now(),
  };
}

function makeAuthService(): AuthService & { signinWithOidc: ReturnType<typeof vi.fn> } {
  const issued: IssuedTokens = {
    user: { id: 'u-1', email: 'alice@example.test' } as IssuedTokens['user'],
    sessionId: 'sess-1',
    accessToken: 'AT.signed.jwt',
    refreshToken: 'RT.opaque',
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    refreshTokenExpiresAt: new Date(Date.now() + 600_000),
  };
  return {
    signinWithOidc: vi.fn().mockResolvedValue(issued),
  } as unknown as AuthService & { signinWithOidc: ReturnType<typeof vi.fn> };
}

describe('OidcController.callback — chemins de rejet', () => {
  let store: ReturnType<typeof makeStateStore>;
  let reply: ReturnType<typeof makeReply>;
  let auth: ReturnType<typeof makeAuthService>;
  let ctrl: OidcController;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    jwtVerifyMock.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    store = makeStateStore();
    reply = makeReply();
    auth = makeAuthService();
    ctrl = new OidcController(makeConfig(), makeDiscovery(), store, auth);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejette quand l'IdP renvoie `error` (ex: user a refusé le consent)", async () => {
    await expect(
      ctrl.callback(undefined, undefined, 'access_denied', 'user said no', FAKE_REQ, reply),
    ).rejects.toThrow(UnauthorizedException);
    expect(store.consume).not.toHaveBeenCalled();
    expect(auth.signinWithOidc).not.toHaveBeenCalled();
  });

  it('rejette en 400 quand code est absent', async () => {
    await expect(
      ctrl.callback(undefined, 'state-x', undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejette en 400 quand state est absent', async () => {
    await expect(
      ctrl.callback('code-x', undefined, undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejette quand state.consume renvoie null (CSRF / replay / expiré)', async () => {
    store.consume = vi.fn().mockResolvedValue(null);
    await expect(
      ctrl.callback('code-x', 'state-unknown', undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(UnauthorizedException);
    expect(fetchSpy).not.toHaveBeenCalled(); // pas d'échange code si state KO
  });

  it("rejette quand l'ID token n'a pas de claim email", async () => {
    store.consume = vi.fn().mockResolvedValue(makeStoredState());
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'kc-AT', id_token: 'kc-IDT', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'kc-sub-1', nonce: 'nonce-abc' /* pas d'email */ },
    });

    await expect(
      ctrl.callback('code-x', 'state-ok', undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(UnauthorizedException);
    expect(auth.signinWithOidc).not.toHaveBeenCalled();
  });

  it('rejette `email_verified=false` (anti-hijack par email non vérifié)', async () => {
    store.consume = vi.fn().mockResolvedValue(makeStoredState());
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'kc-AT', id_token: 'kc-IDT', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'kc-sub-1',
        email: 'victim@example.test',
        email_verified: false,
        nonce: 'nonce-abc',
      },
    });

    await expect(
      ctrl.callback('code-x', 'state-ok', undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(/non vérifié/);
    expect(auth.signinWithOidc).not.toHaveBeenCalled();
  });

  it("rejette quand l'échange code → tokens échoue", async () => {
    store.consume = vi.fn().mockResolvedValue(makeStoredState());
    fetchSpy.mockResolvedValue(new Response('invalid grant', { status: 400 }));

    await expect(
      ctrl.callback('bad-code', 'state-ok', undefined, undefined, FAKE_REQ, reply),
    ).rejects.toThrow(UnauthorizedException);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
    expect(auth.signinWithOidc).not.toHaveBeenCalled();
  });
});

describe('OidcController.callback — happy path', () => {
  let store: ReturnType<typeof makeStateStore>;
  let reply: ReturnType<typeof makeReply>;
  let auth: ReturnType<typeof makeAuthService>;
  let ctrl: OidcController;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    jwtVerifyMock.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    store = makeStateStore();
    reply = makeReply();
    auth = makeAuthService();
    ctrl = new OidcController(makeConfig(), makeDiscovery(), store, auth);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appelle signinWithOidc et redirige avec tokens en fragment', async () => {
    store.consume = vi.fn().mockResolvedValue(makeStoredState());
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: 'kc-AT', id_token: 'kc-IDT', token_type: 'Bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'kc-sub-alice',
        email: 'alice@example.test',
        email_verified: true,
        nonce: 'nonce-abc',
      },
    });

    await ctrl.callback('code-x', 'state-ok', undefined, undefined, FAKE_REQ, reply);

    expect(auth.signinWithOidc).toHaveBeenCalledWith(
      { provider: 'oidc', subject: 'kc-sub-alice', email: 'alice@example.test' },
      { userAgent: 'rt-test', ip: '127.0.0.1' },
    );
    expect(reply.redirect).toHaveBeenCalledTimes(1);
    const [target, status] = reply.redirect.mock.calls[0]!;
    expect(status).toBe(302);

    const parsed = new URL(String(target));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(POST_LOGIN);
    // Tokens en fragment (#), JAMAIS en query (#access_token=…&refresh_token=…).
    expect(parsed.hash).toMatch(/^#/);
    expect(parsed.search).toBe('');
    const frag = new URLSearchParams(parsed.hash.slice(1));
    expect(frag.get('access_token')).toBe('AT.signed.jwt');
    expect(frag.get('refresh_token')).toBe('RT.opaque');
    expect(Number(frag.get('expires_in'))).toBeGreaterThan(0);
  });
});
