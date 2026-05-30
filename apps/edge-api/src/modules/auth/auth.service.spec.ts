import { ConflictException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import type { DatabaseService } from '../../database/database.service';
import type { MetricsService } from '../../observability/metrics.service';
import { AuthService } from './auth.service';
import type { FederatedIdentitiesRepository } from './federated-identities.repository';
import type { JwtService } from './jwt.service';
import { DUMMY_HASH, type PasswordService } from './password.service';
import type { SessionRow, SessionsRepository } from './sessions.repository';
import type { UserRow, UsersRepository } from './users.repository';

// AuthService porte les invariants les plus sensibles du système :
//   - timing-safe signin (hash factice quand l'user n'existe pas, pour ne
//     pas révéler par timing « email inconnu » vs « mot de passe faux »),
//   - rotation des refresh tokens avec détection de réutilisation
//     (revokeChain coupe toute la chaîne dès qu'un token rotated est
//     représenté → cf. RFC 6749 §10.4 + draft-ietf-oauth-security-topics).
// Ces tests caractérisent les chemins, pas l'implémentation : si
// quelqu'un remplace par mégarde `revokeChain` par `revoke` simple, le
// scénario "réutilisation" doit le rattraper.

const TTL_ACCESS = 900;
const TTL_REFRESH = 60 * 60 * 24 * 30;

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}

function makeConfig(): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) => {
      if (key === 'JWT_ACCESS_TTL_SECONDS') return TTL_ACCESS;
      if (key === 'JWT_REFRESH_TTL_SECONDS') return TTL_REFRESH;
      return undefined;
    }),
  } as unknown as ConfigService<Env, true>;
}

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-1',
    email: 'alice@example.test',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$AAA$BBB',
    locale: 'fr-FR',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    userId: 'u-1',
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    rotatedTo: null,
    ...overrides,
  };
}

interface Mocks {
  users: UsersRepository;
  sessions: SessionsRepository;
  passwords: PasswordService;
  jwt: JwtService;
  db: DatabaseService;
  federatedIdentities: FederatedIdentitiesRepository;
  metrics: MetricsService;
}

function makeMocks(): Mocks {
  return {
    users: {
      findActiveByEmail: vi.fn(),
      findActiveById: vi.fn(),
      createWithPassword: vi.fn(),
      createPasswordless: vi.fn(),
    } as unknown as UsersRepository,
    sessions: {
      create: vi.fn().mockResolvedValue(makeSession({ id: 'sess-new' })),
      findByRefreshHash: vi.fn(),
      revoke: vi.fn().mockResolvedValue(undefined),
      revokeChain: vi.fn().mockResolvedValue(undefined),
      markRotated: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionsRepository,
    passwords: {
      hash: vi.fn().mockResolvedValue('hashed'),
      verify: vi.fn(),
    } as unknown as PasswordService,
    jwt: {
      signAccessToken: vi.fn().mockResolvedValue('access-token-xyz'),
    } as unknown as JwtService,
    db: {} as unknown as DatabaseService,
    federatedIdentities: {} as unknown as FederatedIdentitiesRepository,
    metrics: {
      recordAuthAttempt: vi.fn(),
    } as unknown as MetricsService,
  };
}

function makeService(mocks: Mocks): AuthService {
  return new AuthService(
    makeConfig(),
    mocks.users,
    mocks.sessions,
    mocks.passwords,
    mocks.jwt,
    mocks.db,
    mocks.federatedIdentities,
    mocks.metrics,
  );
}

describe('AuthService.refresh — réutilisation et rotation', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('cherche la session via le hash SHA-256 du token (jamais en clair)', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(null);
    await expect(svc.refresh('plain-refresh-token')).rejects.toThrow(
      UnauthorizedException,
    );
    const [hash] = vi.mocked(mocks.sessions.findByRefreshHash).mock.calls[0]!;
    // Si le repo recevait le token en clair, un dump SQL exposerait les
    // refresh tokens actifs. On vérifie qu'on lui passe bien un Buffer
    // de 32 octets (SHA-256).
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect((hash as Buffer).length).toBe(32);
    expect((hash as Buffer).equals(sha256('plain-refresh-token'))).toBe(true);
  });

  it('rejette un token inconnu (findByRefreshHash → null)', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(null);
    await expect(svc.refresh('unknown')).rejects.toThrow(UnauthorizedException);
    expect(mocks.sessions.revokeChain).not.toHaveBeenCalled();
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('refresh', 'failure');
  });

  it('rejette une session révoquée SANS rotatedTo (logout normal, pas une attaque)', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(
      makeSession({ revokedAt: new Date(), rotatedTo: null }),
    );
    await expect(svc.refresh('logged-out')).rejects.toThrow(UnauthorizedException);
    // Pas d'escalade : un user qui clique logout puis ré-essaie d'utiliser
    // son refresh ne mérite pas une révocation en chaîne (il n'y a pas de chaîne).
    expect(mocks.sessions.revokeChain).not.toHaveBeenCalled();
  });

  it('détecte la réutilisation et coupe TOUTE la chaîne (revokedAt + rotatedTo)', async () => {
    // Le scénario d'attaque : un attaquant a volé le refresh token #1,
    // l'utilisateur légitime l'a rotaté (session #2), puis l'attaquant
    // présente #1. On doit révoquer #1 ET #2 (et toute descendance).
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(
      makeSession({
        id: 'sess-stolen',
        revokedAt: new Date(),
        rotatedTo: 'sess-next',
      }),
    );
    await expect(svc.refresh('stolen-after-rotation')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mocks.sessions.revokeChain).toHaveBeenCalledWith('sess-stolen');
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('refresh', 'failure');
  });

  it('rejette une session expirée (sans casser la chaîne, pas une attaque)', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(
      makeSession({ expiresAt: new Date(Date.now() - 1_000) }),
    );
    await expect(svc.refresh('expired')).rejects.toThrow(/expirée/);
    expect(mocks.sessions.revokeChain).not.toHaveBeenCalled();
  });

  it('rejette si l\'user a été supprimé entre-temps', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(makeSession());
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(null);
    await expect(svc.refresh('valid-but-orphan')).rejects.toThrow(UnauthorizedException);
    expect(mocks.sessions.markRotated).not.toHaveBeenCalled();
  });

  it('happy path : crée une nouvelle session et marque l\'ancienne rotated', async () => {
    const oldSession = makeSession({ id: 'sess-old' });
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(oldSession);
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser());

    const issued = await svc.refresh('plain-refresh-token');

    // markRotated lie sess-old → sess-new : indispensable pour la
    // détection de réutilisation lors d'un appel ultérieur.
    expect(mocks.sessions.markRotated).toHaveBeenCalledWith('sess-old', 'sess-new');
    expect(issued.sessionId).toBe('sess-new');
    expect(issued.accessToken).toBe('access-token-xyz');
    expect(issued.refreshToken).toBeTypeOf('string');
    expect(issued.refreshToken.length).toBeGreaterThan(0);
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('refresh', 'success');
  });

  it('emet un refresh token aléatoire (32+ chars base64url, pas réutilisé)', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(makeSession());
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser());

    const a = await svc.refresh('one');
    const b = await svc.refresh('two');
    expect(a.refreshToken).not.toBe(b.refreshToken);
    // base64url : pas de '+', '/', '='
    expect(a.refreshToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 octets → ≥ 43 chars base64url
    expect(a.refreshToken.length).toBeGreaterThanOrEqual(43);
  });
});

describe('AuthService.signin — timing-safe', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('appelle verify() même si l\'user n\'existe pas (timing-equalization)', async () => {
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.passwords.verify).mockResolvedValue(false);

    await expect(svc.signin({ email: 'ghost@x', password: 'p' })).rejects.toThrow(
      UnauthorizedException,
    );

    // CRITIQUE : sans ce verify(), un attaquant distingue par latence
    // « email connu mais mot de passe faux » de « email inconnu », ce
    // qui ouvre l'énumération d'utilisateurs.
    expect(mocks.passwords.verify).toHaveBeenCalledWith(DUMMY_HASH, 'p');
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('signin', 'failure');
  });

  it('rejette quand l\'user existe mais le mot de passe est faux', async () => {
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser());
    vi.mocked(mocks.passwords.verify).mockResolvedValue(false);

    await expect(svc.signin({ email: 'alice@x', password: 'bad' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it('rejette si l\'user n\'a pas de passwordHash (compte fédéré pur)', async () => {
    // Un user créé via OIDC n'a pas de password_hash. Tenter un
    // signin local doit échouer même si l'attaquant tape par hasard
    // une string qui hash vers DUMMY_HASH (~impossible mais filet).
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(
      makeUser({ passwordHash: null }),
    );
    vi.mocked(mocks.passwords.verify).mockResolvedValue(true);

    await expect(svc.signin({ email: 'oidc@x', password: 'p' })).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mocks.sessions.create).not.toHaveBeenCalled();
  });

  it('happy path : retourne des tokens + recordAuthAttempt success', async () => {
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser());
    vi.mocked(mocks.passwords.verify).mockResolvedValue(true);

    const issued = await svc.signin({ email: 'alice@x', password: 'p' });
    expect(issued.accessToken).toBe('access-token-xyz');
    expect(issued.user.id).toBe('u-1');
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('signin', 'success');
  });
});

describe('AuthService.signup — conflict & happy path', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('rejette si l\'email est déjà utilisé', async () => {
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser());
    await expect(
      svc.signup({ email: 'alice@x', password: 'p' }),
    ).rejects.toThrow(ConflictException);
    expect(mocks.users.createWithPassword).not.toHaveBeenCalled();
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('signup', 'failure');
  });

  it('happy path : hash le mot de passe et crée le user', async () => {
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createWithPassword).mockResolvedValue(makeUser());

    await svc.signup({ email: 'new@x', password: 'plaintext' });

    expect(mocks.passwords.hash).toHaveBeenCalledWith('plaintext');
    // Le hash doit être passé au repo — pas le plaintext.
    const createCall = vi.mocked(mocks.users.createWithPassword).mock.calls[0]![0];
    expect(createCall.passwordHash).toBe('hashed');
    expect(createCall.passwordHash).not.toBe('plaintext');
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('signup', 'success');
  });
});

describe('AuthService.logout — idempotent', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('no-op et success metric si le token est inconnu', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(null);
    await svc.logout('unknown-token');
    expect(mocks.sessions.revoke).not.toHaveBeenCalled();
    // logout est *idempotent fonctionnellement* : un client déjà
    // déconnecté qui re-tente reçoit toujours 200, on log success.
    expect(mocks.metrics.recordAuthAttempt).toHaveBeenCalledWith('logout', 'success');
  });

  it('révoque la session quand le token est connu et actif', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(
      makeSession({ id: 'sess-live' }),
    );
    await svc.logout('live-token');
    expect(mocks.sessions.revoke).toHaveBeenCalledWith('sess-live');
  });

  it('ne re-révoque pas une session déjà révoquée', async () => {
    vi.mocked(mocks.sessions.findByRefreshHash).mockResolvedValue(
      makeSession({ id: 'sess-dead', revokedAt: new Date() }),
    );
    await svc.logout('already-revoked');
    expect(mocks.sessions.revoke).not.toHaveBeenCalled();
  });
});
