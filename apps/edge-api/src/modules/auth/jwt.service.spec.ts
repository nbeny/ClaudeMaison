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
import type { FederatedIdentitiesRepository, FederatedIdentityRow } from './federated-identities.repository';
import { JwtService } from './jwt.service';
import type { OidcDiscoveryService } from './oidc/oidc-discovery.service';

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

describe('JwtService', () => {
  it('signe puis vérifie un access token (round-trip)', async () => {
    const svc = new JwtService(makeConfig());
    const token = await svc.signAccessToken({ sub: 'user-123', sid: 'session-456' });
    const claims = await svc.verifyAccessToken(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.sid).toBe('session-456');
  });

  it('refuse un token signé par une autre clé', async () => {
    const a = new JwtService(makeConfig());
    const b = new JwtService(makeConfig({ JWT_SIGNING_KEY: 'b'.repeat(48) }));
    const token = await a.signAccessToken({ sub: 'u', sid: 's' });
    await expect(b.verifyAccessToken(token)).rejects.toThrow();
  });

  it('refuse un token avec mauvaise audience', async () => {
    const a = new JwtService(makeConfig({ JWT_AUDIENCE: 'aud-a' }));
    const b = new JwtService(makeConfig({ JWT_AUDIENCE: 'aud-b' }));
    const token = await a.signAccessToken({ sub: 'u', sid: 's' });
    await expect(b.verifyAccessToken(token)).rejects.toThrow();
  });

  it('refuse un token expiré', async () => {
    const svc = new JwtService(makeConfig({ JWT_ACCESS_TTL_SECONDS: 1 }));
    const token = await svc.signAccessToken({ sub: 'u', sid: 's' });
    await new Promise((r) => setTimeout(r, 1500));
    await expect(svc.verifyAccessToken(token)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Path RS256 / Keycloak — vérification dual-mode pour Phase 1 walking skeleton.
// ---------------------------------------------------------------------------

interface KeycloakFixture {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
}

async function buildKeycloakFixture(opts?: {
  issuer?: string;
  audience?: string;
}): Promise<KeycloakFixture> {
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
    issuer: opts?.issuer ?? 'http://keycloak:8080/realms/claudemaison-dev',
    audience: opts?.audience ?? 'edge-api',
  };
}

async function signKeycloakToken(
  fixture: KeycloakFixture,
  payload: Record<string, unknown> = {},
  overrides?: { iss?: string; aud?: string | string[]; expSeconds?: number },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(overrides?.iss ?? fixture.issuer)
    .setAudience(overrides?.aud ?? fixture.audience)
    .setIssuedAt()
    .setExpirationTime(`${overrides?.expSeconds ?? 60}s`)
    .sign(fixture.privateKey);
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
): FederatedIdentitiesRepository {
  return {
    findByProviderSubject: async (provider: string, subject: string) => {
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
}

describe('JwtService — chemin RS256 (Keycloak)', () => {
  it('accepte un token Keycloak valide et mappe le subject vers l\'user local', async () => {
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const repo = makeFederatedRepo([
      { userId: 'local-user-alice', provider: 'oidc', subject: 'kc-sub-alice' },
    ]);
    const svc = new JwtService(
      makeConfig({ OIDC_CLIENT_ID: fixture.audience }),
      discovery,
      repo,
    );

    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-alice', azp: 'edge-api' });
    const claims = await svc.verifyAccessToken(token);

    expect(claims.sub).toBe('local-user-alice');
    expect(typeof claims.sid).toBe('string');
  });

  it('rejette un token RS256 dont l\'issuer ne correspond pas à celui découvert', async () => {
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const repo = makeFederatedRepo([
      { userId: 'local-user-alice', provider: 'oidc', subject: 'kc-sub-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloakToken(
      fixture,
      { sub: 'kc-sub-alice' },
      { iss: 'http://attacker/realms/evil' },
    );
    await expect(svc.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejette un token RS256 dont le subject n\'a pas d\'identité fédérée', async () => {
    const fixture = await buildKeycloakFixture();
    const discovery = makeDiscovery(fixture);
    const repo = makeFederatedRepo([]); // aucune identité seedée
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-unknown' });
    await expect(svc.verifyAccessToken(token)).rejects.toThrow(
      /Aucune identité fédérée/,
    );
  });

  it('rejette un token RS256 signé par une clé absente du JWKS attendu', async () => {
    const trusted = await buildKeycloakFixture();
    const attacker = await buildKeycloakFixture({ issuer: trusted.issuer });
    // discovery expose seulement les clés de trusted ; l'attaquant signe avec sa propre clé.
    const discovery = makeDiscovery(trusted);
    const repo = makeFederatedRepo([
      { userId: 'local-user-alice', provider: 'oidc', subject: 'kc-sub-alice' },
    ]);
    const svc = new JwtService(makeConfig(), discovery, repo);

    const token = await signKeycloakToken(attacker, { sub: 'kc-sub-alice' });
    await expect(svc.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejette un token RS256 quand OIDC n\'est pas configuré (discovery absent)', async () => {
    const fixture = await buildKeycloakFixture();
    // Pas de discovery ni de repo injectés → fallback Keycloak indisponible,
    // l'erreur HS256 d'origine remonte.
    const svc = new JwtService(makeConfig());
    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-alice' });
    await expect(svc.verifyAccessToken(token)).rejects.toThrow();
  });
});
