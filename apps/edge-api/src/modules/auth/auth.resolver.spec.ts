import type { FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthResolver } from './auth.resolver';
import type { AuthService, IssuedTokens } from './auth.service';
import type { AccessTokenClaims } from './jwt.service';
import type { UserRow, UsersRepository } from './users.repository';

// AuthResolver est la surface GraphQL d'authentification. Ses
// invariants critiques :
//   - `viewer` retourne null (pas une exception, pas une fuite) si le
//     JWT pointe vers un user supprimé — sinon un attaquant qui obtient
//     un vieux refresh-token pour un compte purgé peut faire crasher.
//   - Chaque mutation transmet le RequestContext (UA + IP) à AuthService,
//     parce que c'est ce qui est stocké en auth.sessions pour l'audit.
//   - `viewer` interroge l'user via claims.sub (pas d'arg client) —
//     impossible de demander le viewer d'un autre user.

const CLAIMS: AccessTokenClaims = { sub: 'u-1', sid: 's-1' };

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-1',
    email: 'alice@example.test',
    passwordHash: 'hash',
    locale: 'fr-FR',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeIssued(overrides: Partial<IssuedTokens> = {}): IssuedTokens {
  return {
    user: makeUser(),
    sessionId: 'sess-1',
    accessToken: 'access-xyz',
    refreshToken: 'refresh-xyz',
    accessTokenExpiresAt: new Date('2025-01-01T01:00:00Z'),
    refreshTokenExpiresAt: new Date('2025-02-01T00:00:00Z'),
    ...overrides,
  };
}

function makeReq(overrides: Partial<{ ua: string | undefined; ip: string | undefined }> = {}): {
  req: FastifyRequest;
} {
  return {
    req: {
      headers: { 'user-agent': overrides.ua },
      ip: overrides.ip,
    } as unknown as FastifyRequest,
  };
}

interface Mocks {
  auth: AuthService;
  users: UsersRepository;
}

function makeMocks(): Mocks {
  return {
    auth: {
      signup: vi.fn().mockResolvedValue(makeIssued()),
      signin: vi.fn().mockResolvedValue(makeIssued()),
      refresh: vi.fn().mockResolvedValue(makeIssued()),
      logout: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuthService,
    users: {
      findActiveById: vi.fn(),
    } as unknown as UsersRepository,
  };
}

describe('AuthResolver.viewer', () => {
  let mocks: Mocks;
  let resolver: AuthResolver;

  beforeEach(() => {
    mocks = makeMocks();
    resolver = new AuthResolver(mocks.auth, mocks.users);
  });

  it('retourne null si le user a été supprimé (anti-fuite, anti-crash)', async () => {
    // Un attaquant qui possède encore un access-token pour un compte
    // récemment purgé ne doit pas faire crasher la query — sinon il
    // peut détecter par 5xx que l'user a été supprimé.
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(null);
    await expect(resolver.viewer(CLAIMS)).resolves.toBeNull();
  });

  it('interroge l\'user via claims.sub (pas d\'arg client → pas d\'usurpation)', async () => {
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser());
    await resolver.viewer(CLAIMS);
    expect(mocks.users.findActiveById).toHaveBeenCalledWith(CLAIMS.sub);
  });

  it('retourne {id, email, workspaces:[]} pour un user actif', async () => {
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(
      makeUser({ id: 'u-42', email: 'bob@x' }),
    );
    const v = await resolver.viewer(CLAIMS);
    expect(v).not.toBeNull();
    expect(v!.id).toBe('u-42');
    expect(v!.email).toBe('bob@x');
    // Contrat actuel : workspaces vide tant que pas câblé. Quand on
    // branchera la liste, ce test cassera et rappellera de mettre à jour.
    expect(v!.workspaces).toEqual([]);
  });
});

describe('AuthResolver.signup / signin / refresh — propagation du RequestContext', () => {
  let mocks: Mocks;
  let resolver: AuthResolver;

  beforeEach(() => {
    mocks = makeMocks();
    resolver = new AuthResolver(mocks.auth, mocks.users);
  });

  it('signup : passe input + {userAgent, ip} à AuthService.signup', async () => {
    const input = { email: 'alice@x', password: 'longenoughpw' };
    const ctx = makeReq({ ua: 'Firefox/120', ip: '10.0.0.42' });
    await resolver.signup(input, ctx);
    expect(mocks.auth.signup).toHaveBeenCalledWith(input, {
      userAgent: 'Firefox/120',
      ip: '10.0.0.42',
    });
  });

  it('signin : passe input + {userAgent, ip} à AuthService.signin', async () => {
    const input = { email: 'alice@x', password: 'longenoughpw' };
    const ctx = makeReq({ ua: 'curl/8', ip: '1.2.3.4' });
    await resolver.signin(input, ctx);
    expect(mocks.auth.signin).toHaveBeenCalledWith(input, {
      userAgent: 'curl/8',
      ip: '1.2.3.4',
    });
  });

  it('refresh : extrait input.refreshToken (pas tout l\'input)', async () => {
    const input = { refreshToken: 'rt-abc' };
    const ctx = makeReq({ ua: 'Safari', ip: '8.8.8.8' });
    await resolver.refresh(input, ctx);
    // Important : le 1er arg de auth.refresh est la string, pas l'objet
    // (sinon auth.refresh recevrait `{refreshToken: "..."}` et le hash
    // SHA-256 ne matcherait jamais une session).
    expect(mocks.auth.refresh).toHaveBeenCalledWith('rt-abc', {
      userAgent: 'Safari',
      ip: '8.8.8.8',
    });
  });

  it('RequestContext utilise null (pas undefined) quand UA et IP sont absents', async () => {
    // null est ce qu'on stocke en DB pour les colonnes nullables —
    // undefined sérialisé en SQL passerait DEFAULT, pas NULL, ce qui
    // pourrait remplir par mégarde une colonne avec une string vide.
    const input = { email: 'alice@x', password: 'longenoughpw' };
    const ctx = makeReq({});
    await resolver.signup(input, ctx);
    expect(mocks.auth.signup).toHaveBeenCalledWith(input, {
      userAgent: null,
      ip: null,
    });
  });
});

describe('AuthResolver.signup/signin/refresh — forme du payload', () => {
  let mocks: Mocks;
  let resolver: AuthResolver;

  beforeEach(() => {
    mocks = makeMocks();
    resolver = new AuthResolver(mocks.auth, mocks.users);
  });

  it('payload inclut accessToken, refreshToken, expirations et viewer', async () => {
    const issued = makeIssued({
      accessToken: 'at',
      refreshToken: 'rt',
      user: makeUser({ id: 'u-77', email: 'zoe@x' }),
    });
    vi.mocked(mocks.auth.signup).mockResolvedValue(issued);
    const payload = await resolver.signup(
      { email: 'zoe@x', password: 'longenoughpw' },
      makeReq(),
    );
    expect(payload.accessToken).toBe('at');
    expect(payload.refreshToken).toBe('rt');
    expect(payload.accessTokenExpiresAt).toEqual(issued.accessTokenExpiresAt);
    expect(payload.refreshTokenExpiresAt).toEqual(issued.refreshTokenExpiresAt);
    expect(payload.viewer.id).toBe('u-77');
    expect(payload.viewer.email).toBe('zoe@x');
    expect(payload.viewer.workspaces).toEqual([]);
  });
});

describe('AuthResolver.logout', () => {
  let mocks: Mocks;
  let resolver: AuthResolver;

  beforeEach(() => {
    mocks = makeMocks();
    resolver = new AuthResolver(mocks.auth, mocks.users);
  });

  it('extrait input.refreshToken et appelle AuthService.logout', async () => {
    const ok = await resolver.logout({ refreshToken: 'rt-bye' });
    expect(mocks.auth.logout).toHaveBeenCalledWith('rt-bye');
    expect(ok).toBe(true);
  });

  it('retourne true même si le token est inconnu (idempotence côté API)', async () => {
    vi.mocked(mocks.auth.logout).mockResolvedValue(undefined);
    const ok = await resolver.logout({ refreshToken: 'unknown-rt' });
    expect(ok).toBe(true);
  });
});
