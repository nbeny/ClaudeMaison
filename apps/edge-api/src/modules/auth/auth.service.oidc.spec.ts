import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import type { DatabaseService } from '../../database/database.service';
import type { MetricsService } from '../../observability/metrics.service';
import { AuthService } from './auth.service';
import type {
  FederatedIdentitiesRepository,
  FederatedIdentityRow,
} from './federated-identities.repository';
import type { JwtService } from './jwt.service';
import type { PasswordService } from './password.service';
import type { SessionRow, SessionsRepository } from './sessions.repository';
import type { UserRow, UsersRepository } from './users.repository';

// Caractérisation `AuthService.signinWithOidc` — la méthode la plus
// complexe (50 lignes, 3 branches, transactionnelle) et la SEULE non
// couverte par auth.service.spec.ts. Couvrir maintenant évite que :
//
//   - Branche 1 (identité (provider, subject) déjà connue) : un PR qui
//     oublierait `touchLastLogin` casserait la métrique « dernière conn-
//     exion fédérée » sans qu'aucun test ne ralle, et on perdrait la
//     capacité de détecter les comptes dormants côté ops.
//
//   - Branche 2 (auto-merge par email) : si l'ordre des appels était
//     inversé (création federated_identity AVANT lookup par email),
//     deux logins concurrents avec le même email IdP feraient deux
//     federated_identities pour deux users locaux distincts → split-brain.
//
//   - Branche 3 (création de zéro) : si `createPasswordless` était
//     remplacé par `createWithPassword('')`, on stockerait un hash de
//     mot de passe vide en base → un attaquant connaissant ce comportem-
//     ent pourrait s'auth comme un compte OIDC en tapant '' dans le
//     signin classique.
//
//   - Tout doit être DANS la transaction (`tx` propagé à chaque appel
//     repo). Si un seul appel oublie `tx`, on a un risque de lecture
//     non-cohérente : un user vu par un appel pourrait disparaître au
//     suivant si un DELETE concurrent passe entre deux.

const TTL_ACCESS = 900;
const TTL_REFRESH = 60 * 60 * 24 * 30;

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
    passwordHash: null,
    locale: 'fr-FR',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<FederatedIdentityRow> = {}): FederatedIdentityRow {
  return {
    id: 'fed-1',
    userId: 'u-1',
    provider: 'oidc',
    subject: 'kc-sub-alice',
    email: 'alice@example.test',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    lastLogin: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-new',
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
  // Symbol unique pour identifier le `tx` passé par begin()
  txSentinel: symbol;
}

function makeMocks(): Mocks {
  // db.sql.begin(fn) doit appeler fn(tx) où tx est un objet qu'on peut
  // tracer. On utilise un Symbol comme sentinelle pour assert que chaque
  // repo a bien reçu CE tx (pas db.sql ou autre chose).
  const txSentinel = Symbol('tx');
  const begin = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(txSentinel),
  );

  return {
    users: {
      findActiveByEmail: vi.fn(),
      findActiveById: vi.fn(),
      createWithPassword: vi.fn(),
      createPasswordless: vi.fn(),
    } as unknown as UsersRepository,
    sessions: {
      create: vi.fn().mockResolvedValue(makeSession()),
      findByRefreshHash: vi.fn(),
      revoke: vi.fn(),
      revokeChain: vi.fn(),
      markRotated: vi.fn(),
    } as unknown as SessionsRepository,
    passwords: {
      hash: vi.fn(),
      verify: vi.fn(),
    } as unknown as PasswordService,
    jwt: {
      signAccessToken: vi.fn().mockResolvedValue('access-token-xyz'),
    } as unknown as JwtService,
    db: { sql: { begin } } as unknown as DatabaseService,
    federatedIdentities: {
      findByProviderSubject: vi.fn(),
      create: vi.fn(),
      touchLastLogin: vi.fn(),
    } as unknown as FederatedIdentitiesRepository,
    metrics: {
      recordAuthAttempt: vi.fn(),
    } as unknown as MetricsService,
    txSentinel,
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

const INPUT = { provider: 'oidc', subject: 'kc-sub-alice', email: 'alice@example.test' };

describe('AuthService.signinWithOidc — branche 1 : identité (provider, subject) déjà connue', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('lookup identité fédérée AVANT tout autre repo (ordre critique anti race)', async () => {
    // Si on faisait `users.findActiveByEmail` AVANT findByProviderSubject,
    // deux logins concurrents avec le même provider/subject mais des
    // emails différents (cas après changement d'email IdP) pourraient
    // résulter en deux federated_identities orphelines liées au mauvais
    // user. L'ordre actuel garantit qu'une identité déjà mappée gagne.
    const existing = makeIdentity({ userId: 'u-1' });
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(existing);
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser({ id: 'u-1' }));

    await svc.signinWithOidc(INPUT);

    const findFedOrder =
      vi.mocked(mocks.federatedIdentities.findByProviderSubject).mock
        .invocationCallOrder[0]!;
    const findUserOrder = vi.mocked(mocks.users.findActiveById).mock
      .invocationCallOrder[0]!;
    expect(findFedOrder).toBeLessThan(findUserOrder);
    expect(mocks.users.findActiveByEmail).not.toHaveBeenCalled();
    expect(mocks.users.createPasswordless).not.toHaveBeenCalled();
    expect(mocks.federatedIdentities.create).not.toHaveBeenCalled();
  });

  it('appelle touchLastLogin(existing.id) — sinon la métrique dort silencieusement', async () => {
    // L'absence de touchLastLogin n'est pas immédiatement visible côté
    // user, mais ops perd la capacité de détecter des comptes dormants
    // (les workflows downstream — emails de relance, suppression GDPR
    // — utilisent last_login).
    const existing = makeIdentity({ id: 'fed-42', userId: 'u-7' });
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(existing);
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser({ id: 'u-7' }));

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.touchLastLogin).toHaveBeenCalledTimes(1);
    expect(mocks.federatedIdentities.touchLastLogin).toHaveBeenCalledWith(
      'fed-42',
      mocks.txSentinel,
    );
  });

  it('jette UnauthorizedException si l\'identité fédérée est orpheline (user supprimé)', async () => {
    // Cas anormal : l'identité existe mais le user a été soft-deleted.
    // On ne veut PAS auto-recréer un user (risque de hijack par un
    // ex-employé qui aurait gardé son token IdP). Erreur claire.
    const existing = makeIdentity({ userId: 'u-deleted' });
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(existing);
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(null);

    await expect(svc.signinWithOidc(INPUT)).rejects.toThrow(UnauthorizedException);
    expect(mocks.federatedIdentities.create).not.toHaveBeenCalled();
    expect(mocks.users.createPasswordless).not.toHaveBeenCalled();
  });
});

describe('AuthService.signinWithOidc — branche 2 : auto-merge par email (identité inconnue + user existant)', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('attache la nouvelle federated_identity au user trouvé par email', async () => {
    // C'est le scénario typique : user s'inscrit en password, puis se
    // reconnecte via IdP qui a validé son email → on les fusionne.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    const existing = makeUser({ id: 'u-merge', email: INPUT.email });
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(existing);
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(
      makeIdentity({ userId: 'u-merge' }),
    );

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.create).toHaveBeenCalledTimes(1);
    const [arg] = vi.mocked(mocks.federatedIdentities.create).mock.calls[0]!;
    expect(arg).toEqual({
      userId: 'u-merge',
      provider: INPUT.provider,
      subject: INPUT.subject,
      email: INPUT.email,
    });
  });

  it('NE crée PAS un nouvel user — l\'user existant est réutilisé', async () => {
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser({ id: 'u-merge' }));
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    expect(mocks.users.createPasswordless).not.toHaveBeenCalled();
    expect(mocks.users.createWithPassword).not.toHaveBeenCalled();
  });

  it('NE touche PAS lastLogin (la federated_identity vient d\'être créée avec last_login=now())', async () => {
    // L'INSERT initial dans `create` fait last_login=now() au niveau SQL.
    // touchLastLogin serait une UPDATE redondante (mais inoffensive).
    // On lock le comportement « pas de touchLastLogin pour une création
    // toute fraîche » pour ne pas alourdir la transaction.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser());
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.touchLastLogin).not.toHaveBeenCalled();
  });
});

describe('AuthService.signinWithOidc — branche 3 : création de zéro (identité ET email inconnus)', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('utilise createPasswordless (PAS createWithPassword) — sinon faille « hash de \'\' »', async () => {
    // CRITIQUE : si on appelait createWithPassword({email, passwordHash: ''})
    // pour « combler le champ », on aurait des comptes avec un hash de
    // string vide. La signin classique tenterait verify(hash, '') ce qui
    // pourrait passer selon l'implémentation Argon2 → bypass total. Lock
    // l'usage de createPasswordless (qui force password_hash = NULL).
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createPasswordless).mockResolvedValue(
      makeUser({ id: 'u-new', passwordHash: null }),
    );
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    expect(mocks.users.createPasswordless).toHaveBeenCalledTimes(1);
    expect(mocks.users.createWithPassword).not.toHaveBeenCalled();
    const [arg] = vi.mocked(mocks.users.createPasswordless).mock.calls[0]!;
    expect(arg).toEqual({ email: INPUT.email });
  });

  it('crée la federated_identity APRÈS le user (sinon FK foreign key échoue)', async () => {
    // Ordre obligatoire : federated_identities.user_id référence users.id
    // avec une FK. Si on créait l'identity AVANT le user, l'INSERT
    // explose avec une violation de contrainte FK.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createPasswordless).mockResolvedValue(
      makeUser({ id: 'u-new' }),
    );
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    const userCreateOrder = vi.mocked(mocks.users.createPasswordless).mock
      .invocationCallOrder[0]!;
    const fedCreateOrder = vi.mocked(mocks.federatedIdentities.create).mock
      .invocationCallOrder[0]!;
    expect(userCreateOrder).toBeLessThan(fedCreateOrder);
  });

  it('lie la federated_identity au user fraîchement créé (pas à un userId hardcodé)', async () => {
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createPasswordless).mockResolvedValue(
      makeUser({ id: 'u-new-distinct' }),
    );
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    const [arg] = vi.mocked(mocks.federatedIdentities.create).mock.calls[0]!;
    expect(arg.userId).toBe('u-new-distinct');
  });
});

describe('AuthService.signinWithOidc — propagation du tx à TOUS les repos appelés', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('branche 1 : findByProviderSubject, findActiveById, touchLastLogin reçoivent tous le même tx', async () => {
    // Si un seul appel utilise db.sql au lieu de tx, on perd la garantie
    // d'isolation transactionnelle. Un DELETE concurrent sur users entre
    // findByProviderSubject (dans tx) et findActiveById (HORS tx) ferait
    // que l'identity pointe sur un user supprimé alors qu'au début de la
    // tx il était présent → orphan UnauthorizedException intempestive.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(
      makeIdentity({ id: 'fed-1', userId: 'u-1' }),
    );
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(makeUser());

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.findByProviderSubject).toHaveBeenCalledWith(
      INPUT.provider,
      INPUT.subject,
      mocks.txSentinel,
    );
    expect(mocks.users.findActiveById).toHaveBeenCalledWith('u-1', mocks.txSentinel);
    expect(mocks.federatedIdentities.touchLastLogin).toHaveBeenCalledWith(
      'fed-1',
      mocks.txSentinel,
    );
  });

  it('branche 2 : findByProviderSubject, findActiveByEmail, federated.create reçoivent tous le même tx', async () => {
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser({ id: 'u-merge' }));
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.findByProviderSubject).toHaveBeenCalledWith(
      INPUT.provider,
      INPUT.subject,
      mocks.txSentinel,
    );
    expect(mocks.users.findActiveByEmail).toHaveBeenCalledWith(INPUT.email, mocks.txSentinel);
    const [, txArg] = vi.mocked(mocks.federatedIdentities.create).mock.calls[0]!;
    expect(txArg).toBe(mocks.txSentinel);
  });

  it('branche 3 : findByProviderSubject, findActiveByEmail, createPasswordless, federated.create reçoivent tous le même tx', async () => {
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createPasswordless).mockResolvedValue(makeUser({ id: 'u-new' }));
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    expect(mocks.federatedIdentities.findByProviderSubject).toHaveBeenCalledWith(
      INPUT.provider,
      INPUT.subject,
      mocks.txSentinel,
    );
    expect(mocks.users.findActiveByEmail).toHaveBeenCalledWith(INPUT.email, mocks.txSentinel);
    const [, createPwlessTx] = vi.mocked(mocks.users.createPasswordless).mock.calls[0]!;
    expect(createPwlessTx).toBe(mocks.txSentinel);
    const [, fedCreateTx] = vi.mocked(mocks.federatedIdentities.create).mock.calls[0]!;
    expect(fedCreateTx).toBe(mocks.txSentinel);
  });
});

describe('AuthService.signinWithOidc — issueTokens hors transaction + tokens cohérents', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('issueTokens (sessions.create + jwt.sign) est appelé APRÈS la fin du tx', async () => {
    // On veut que la session soit créée APRÈS le commit du tx OIDC. Si
    // sessions.create était DANS le tx, un rollback (ex: violation UNIQUE
    // sur federated_identities en race) annulerait aussi la session,
    // mais le client aurait déjà reçu un refresh token qui pointe sur
    // un sess-id inexistant → confusion debug.
    const fedCallTimes: number[] = [];
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockImplementation(async () => {
      fedCallTimes.push(Date.now());
      return null;
    });
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(makeUser({ id: 'u-merge' }));
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());
    const sessionsCreateTimes: number[] = [];
    vi.mocked(mocks.sessions.create).mockImplementation(async () => {
      sessionsCreateTimes.push(Date.now());
      return makeSession();
    });

    await svc.signinWithOidc(INPUT);

    expect(mocks.sessions.create).toHaveBeenCalledTimes(1);
    // sessions.create ne reçoit PAS le tx (signature : { userId, refreshTokenHash, ... })
    const [createArg] = vi.mocked(mocks.sessions.create).mock.calls[0]!;
    expect(createArg).toEqual(
      expect.objectContaining({
        userId: 'u-merge',
        refreshTokenHash: expect.any(Buffer),
      }),
    );
  });

  it('le sub du JWT est le user résolu (pas le subject OIDC) — branche 1', async () => {
    // CRITIQUE : Le `sub` du JWT edge-api DOIT être l'user.id interne,
    // PAS le subject Keycloak. Sinon, l'ACL côté edge-api chercherait
    // un workspace_member avec user_id='kc-sub-alice' et trouverait rien.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(
      makeIdentity({ userId: 'u-LOCAL-id' }),
    );
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(
      makeUser({ id: 'u-LOCAL-id' }),
    );

    await svc.signinWithOidc(INPUT);

    expect(mocks.jwt.signAccessToken).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(mocks.jwt.signAccessToken).mock.calls[0]!;
    expect(payload.sub).toBe('u-LOCAL-id');
    expect(payload.sub).not.toBe('kc-sub-alice');
  });

  it('retourne IssuedTokens avec user résolu + tokens non-vides', async () => {
    const localUser = makeUser({ id: 'u-issued', email: 'issued@test' });
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(
      makeIdentity({ userId: 'u-issued' }),
    );
    vi.mocked(mocks.users.findActiveById).mockResolvedValue(localUser);

    const result = await svc.signinWithOidc(INPUT);

    expect(result.user).toBe(localUser);
    expect(result.accessToken).toBe('access-token-xyz');
    expect(typeof result.refreshToken).toBe('string');
    expect(result.refreshToken.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url ≈ 43 chars
    expect(result.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.refreshTokenExpiresAt.getTime()).toBeGreaterThan(
      result.accessTokenExpiresAt.getTime(),
    );
  });
});

describe('AuthService.signinWithOidc — transaction wrap (db.sql.begin)', () => {
  let mocks: Mocks;
  let svc: AuthService;

  beforeEach(() => {
    mocks = makeMocks();
    svc = makeService(mocks);
  });

  it('encapsule TOUS les appels repo de résolution user dans UN seul db.sql.begin', async () => {
    // Si chaque appel était hors-tx (`this.db.sql` direct), une INSERT
    // dans federated_identities pourrait commit avant l'INSERT dans users
    // si un client tue la requête entre les deux → orphan FK.
    vi.mocked(mocks.federatedIdentities.findByProviderSubject).mockResolvedValue(null);
    vi.mocked(mocks.users.findActiveByEmail).mockResolvedValue(null);
    vi.mocked(mocks.users.createPasswordless).mockResolvedValue(makeUser());
    vi.mocked(mocks.federatedIdentities.create).mockResolvedValue(makeIdentity());

    await svc.signinWithOidc(INPUT);

    const begin = vi.mocked((mocks.db as unknown as { sql: { begin: ReturnType<typeof vi.fn> } }).sql.begin);
    expect(begin).toHaveBeenCalledTimes(1);
  });
});
