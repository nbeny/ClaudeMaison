import { ConfigService } from '@nestjs/config';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import type {
  FederatedIdentitiesRepository,
  FederatedIdentityRow,
} from './federated-identities.repository';
import { JwtService } from './jwt.service';
import type { OidcDiscoveryService } from './oidc/oidc-discovery.service';

// Caractérisation JwtService — invariants subtils NON couverts par
// jwt.service.spec.ts (round-trip, mauvaise clé, mauvaise audience,
// expiré, RS256 round-trip basique).
//
// Verrouillage des comportements-piège pour Phase 1 dual-mode (HS256 local
// + RS256 Keycloak) :
//
//   - **PRIORITÉ HS256 → RS256** : un token HS256 valide ne déclenche
//     JAMAIS le chemin Keycloak (court-circuit). Sans ça, on dépenserait
//     un appel JWKS à chaque vérif locale, et un attaquant pourrait tenter
//     une confusion d'algorithme. La voie locale est nominale.
//
//   - **CHEMIN HS256 — sub manquant → throw `mal formé`** : si quelqu'un
//     force un payload sans `sub` (clé compromise + payload custom), on
//     refuse explicitement plutôt que de retourner `{sub: undefined, sid}`
//     qui ferait planter les requêtes downstream.
//
//   - **CHEMIN HS256 — sid manquant → throw `mal formé`** : symétrique.
//     Sans sid, on ne peut pas tracer la session ni la révoquer.
//
//   - **CHEMIN RS256 — sid absent du payload Keycloak → string vide `''`**
//     (PAS undefined, PAS null). C'est un compromis Jour-1 : les tokens
//     Keycloak n'embarquent pas toujours `sid` ; on accepte plutôt que
//     refuser. Si on changeait pour undefined, les downstream qui
//     stringifient feraient apparaître "undefined" en log.
//
//   - **CHEMIN RS256 — la voie est SAUTÉE si OIDC pas configuré** : pas
//     de discovery → rethrow l'erreur HS256 d'origine. Le `localErr`
//     préserve le message diagnostic plutôt qu'un "Aucune identité
//     fédérée" trompeur.
//
//   - **CHEMIN RS256 — provider toujours `'oidc'`** : le repo est
//     interrogé avec ('oidc', payload.sub). Si on ajoute Google/Apple
//     plus tard, ils auront leur propre route — pas un fallback ici.
//
//   - **MAPPING sub : Keycloak sub → user local** : la réponse contient
//     `identity.userId` (local), JAMAIS le sub Keycloak brut. Sinon les
//     ACL downstream (`claims.sub === user.id`) seraient cassées.

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Env = {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://x@localhost/x',
    REDIS_URL: 'redis://localhost',
    JWT_ISSUER: 'edge-api-test',
    JWT_AUDIENCE: 'edge-api-test',
    JWT_SIGNING_KEY: 'a'.repeat(48),
    JWT_ACCESS_TTL_SECONDS: 60,
    JWT_REFRESH_TTL_SECONDS: 3600,
    ALLOWED_ORIGINS: ['http://localhost:3001'],
    BILLING_GRPC_HOST: '0.0.0.0',
    BILLING_GRPC_PORT: 5001,
    INTERNAL_SHARED_SECRET: 'x'.repeat(32),
    AI_CORE_URL: 'http://ai-core:5001',
    OTEL_SERVICE_NAME: 'edge-api',
    ...overrides,
  };
  return {
    get<K extends keyof Env>(key: K): Env[K] {
      return env[key];
    },
  } as unknown as ConfigService<Env, true>;
}

interface KeycloakFixture {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

async function buildKeycloakFixture(): Promise<KeycloakFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'test-kid';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return {
    privateKey,
    publicJwk,
    jwks,
    issuer: 'http://keycloak:8080/realms/claudemaison-dev',
    audience: 'edge-api',
  };
}

function makeDiscovery(fixture: KeycloakFixture): OidcDiscoveryService {
  return {
    getJwks: () => fixture.jwks,
    getMetadata: () => ({
      issuer: fixture.issuer,
      authorizationEndpoint: '',
      tokenEndpoint: '',
      jwksUri: '',
    }),
  } as unknown as OidcDiscoveryService;
}

function makeFederatedRepo(
  rows: Array<Pick<FederatedIdentityRow, 'userId' | 'provider' | 'subject'>>,
): {
  repo: FederatedIdentitiesRepository;
  calls: Array<{ provider: string; subject: string }>;
} {
  const calls: Array<{ provider: string; subject: string }> = [];
  const repo = {
    findByProviderSubject: async (provider: string, subject: string) => {
      calls.push({ provider, subject });
      const r = rows.find((x) => x.provider === provider && x.subject === subject);
      if (!r) return null;
      return {
        id: 'fid-' + r.subject,
        userId: r.userId,
        provider: r.provider,
        subject: r.subject,
        email: null,
        createdAt: new Date(),
        lastLogin: null,
      };
    },
  } as unknown as FederatedIdentitiesRepository;
  return { repo, calls };
}

async function signLocalManual(
  payload: Record<string, unknown>,
  key: string,
  iss = 'edge-api-test',
  aud = 'edge-api-test',
): Promise<string> {
  // Sign HS256 avec la même clé que JwtService mais avec un payload
  // custom (potentiellement malformé). On bypass le helper officiel pour
  // pouvoir omettre sub/sid.
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(key));
}

describe('JwtService — chemin HS256 local : payload malformé', () => {
  it('refuse un token avec sub manquant (erreur explicite "mal formé")', async () => {
    const cfg = makeConfig();
    const svc = new JwtService(cfg);
    // Token signé OK mais sans sub. SignJWT n'oblige pas à setSubject().
    const token = await signLocalManual({ sid: 'session-1' }, 'a'.repeat(48));
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/mal formé/);
  });

  it('refuse un token avec sid manquant (erreur explicite "mal formé")', async () => {
    const svc = new JwtService(makeConfig());
    const token = await signLocalManual({ sub: 'user-1' }, 'a'.repeat(48));
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/mal formé/);
  });

  it('refuse un token avec sid de mauvais type (number)', async () => {
    // typeof 42 !== 'string' → rejette. Sans la garde, un payload
    // forgé avec sid numérique passerait silencieusement et casserait
    // les sessions downstream.
    const svc = new JwtService(makeConfig());
    const token = await signLocalManual({ sub: 'user-1', sid: 42 }, 'a'.repeat(48));
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/mal formé/);
  });
});

describe('JwtService — priorité HS256 sur RS256', () => {
  it('un token HS256 valide N\'APPELLE PAS le repo fédéré (court-circuit)', async () => {
    // Si la voie locale réussit, la voie Keycloak ne DOIT jamais être
    // tentée. Sinon : double-vérif inutile, charge JWKS, race possible.
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo, calls } = makeFederatedRepo([
      { userId: 'should-not-be-used', provider: 'oidc', subject: 'irrelevant' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await svc.signAccessToken({ sub: 'local-u', sid: 'local-s' });
    const claims = await svc.verifyAccessToken(token);

    expect(claims).toEqual({ sub: 'local-u', sid: 'local-s' });
    expect(calls).toEqual([]); // repo jamais sollicité
  });

  it('sans OIDC configuré, l\'erreur HS256 d\'origine est rethrow (pas masquée)', async () => {
    // Si on remplaçait localErr par une erreur générique, le diagnostic
    // (mauvaise sig, expiré, mauvaise aud…) serait perdu.
    const svc = new JwtService(makeConfig());
    const wrongKeyToken = await signLocalManual(
      { sub: 'u', sid: 's' },
      'z'.repeat(48), // clé différente de celle du svc
    );
    // jose lance JWSSignatureVerificationFailed pour mauvaise signature
    await expect(svc.verifyAccessToken(wrongKeyToken)).rejects.toThrow(/signature/i);
  });
});

describe('JwtService — chemin RS256 (Keycloak) : invariants subtils', () => {
  async function signKeycloak(
    fixture: KeycloakFixture,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(fixture.issuer)
      .setAudience(fixture.audience)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(fixture.privateKey);
  }

  it('sid absent du payload Keycloak → claims.sid = "" (string vide, PAS undefined)', async () => {
    // Compromis Jour-1 : les tokens Keycloak peuvent ne pas embarquer
    // sid. On accepte avec '' plutôt que de refuser. Vérouille le type
    // pour éviter qu'un downstream stringifie undefined→"undefined".
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo } = makeFederatedRepo([
      { userId: 'local-alice', provider: 'oidc', subject: 'kc-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloak(fixture, { sub: 'kc-alice' /* no sid */ });
    const claims = await svc.verifyAccessToken(token);

    expect(claims.sub).toBe('local-alice');
    expect(claims.sid).toBe('');
    expect(typeof claims.sid).toBe('string');
  });

  it('sid de mauvais type (number) → claims.sid = "" (PAS le nombre)', async () => {
    // `typeof payload.sid === 'string' ? payload.sid : ''` — un sid
    // numérique est traité comme absent. Sinon : downstream qui
    // attendent string crashent.
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo } = makeFederatedRepo([
      { userId: 'local-alice', provider: 'oidc', subject: 'kc-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloak(fixture, { sub: 'kc-alice', sid: 42 });
    const claims = await svc.verifyAccessToken(token);

    expect(claims.sid).toBe('');
  });

  it('le repo est interrogé avec provider="oidc" (PAS "keycloak" ni payload.iss)', async () => {
    // Verrouille le couplage : tant qu'on n'a qu'un seul IdP fédéré,
    // 'oidc' est l'unique provider en table. Si on ajoute Google plus
    // tard, ce sera via un autre chemin, pas en muant 'oidc' en
    // 'keycloak' ici.
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo, calls } = makeFederatedRepo([
      { userId: 'local-alice', provider: 'oidc', subject: 'kc-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloak(fixture, { sub: 'kc-alice' });
    await svc.verifyAccessToken(token);

    expect(calls).toEqual([{ provider: 'oidc', subject: 'kc-alice' }]);
  });

  it('le sub retourné est l\'identifiant LOCAL, JAMAIS le sub Keycloak brut', async () => {
    // CRITIQUE pour la sécurité : si downstream voyait `kc-alice` au
    // lieu de `local-alice`, les ACL `row.user_id === claims.sub`
    // échoueraient en silence et l'utilisateur paraîtrait n'avoir
    // accès à rien — ou pire, à autre chose.
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo } = makeFederatedRepo([
      { userId: 'local-alice', provider: 'oidc', subject: 'kc-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloak(fixture, { sub: 'kc-alice' });
    const claims = await svc.verifyAccessToken(token);

    expect(claims.sub).toBe('local-alice');
    expect(claims.sub).not.toBe('kc-alice');
  });

  it('refuse un token RS256 avec sub manquant (erreur explicite "mal formé")', async () => {
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const { repo } = makeFederatedRepo([]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloak(fixture, { /* no sub */ sid: 'kc-sess' });
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(/mal formé/);
  });
});
