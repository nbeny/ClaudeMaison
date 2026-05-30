import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { TokenVerifier, type FederatedSubjectResolver } from './auth';
import type { Env } from './config/env';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    HTTP_PORT: 3100,
    HTTP_HOST: '127.0.0.1',
    LOG_LEVEL: 'info',
    JWT_SIGNING_KEY: 'a'.repeat(48),
    JWT_ISSUER: 'edge-api-test',
    JWT_AUDIENCE: 'edge-api-test',
    NATS_URL: 'nats://localhost:4222',
    NATS_STREAM: 'events',
    OTEL_SERVICE_NAME: 'realtime-test',
    EDGE_API_INTERNAL_URL: 'http://edge-api:3000',
    INTERNAL_SHARED_SECRET: 'x'.repeat(32),
    ...overrides,
  };
}

describe('TokenVerifier — chemin HS256 (token edge-api)', () => {
  it('accepte un token HS256 valide signé avec la clé partagée', async () => {
    const env = makeEnv();
    const key = new TextEncoder().encode(env.JWT_SIGNING_KEY);
    const token = await new SignJWT({ sid: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('local-user-1')
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(key);

    const verifier = new TokenVerifier(env);
    const claims = await verifier.verify(token);
    expect(claims).toEqual({ sub: 'local-user-1', sid: 's1' });
  });

  it('rejette un token HS256 signé avec une autre clé', async () => {
    const env = makeEnv();
    const wrongKey = new TextEncoder().encode('b'.repeat(48));
    const token = await new SignJWT({ sid: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('local-user-1')
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(wrongKey);

    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Chemin RS256 / Keycloak — symétrique à edge-api JwtService. Realtime n'a
// pas d'accès direct à Postgres : le mapping subject → local user passe par
// un resolver injecté (HTTP round-trip vers edge-api en prod).
// ---------------------------------------------------------------------------

interface KeycloakFixture {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jwks: JWTVerifyGetKey;
  issuer: string;
}

async function buildKeycloakFixture(opts?: {
  issuer?: string;
}): Promise<KeycloakFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'rt-test-kid';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });
  return {
    privateKey,
    publicJwk,
    jwks,
    issuer: opts?.issuer ?? 'http://keycloak:8080/realms/claudemaison-dev',
  };
}

async function signKeycloakToken(
  fixture: KeycloakFixture,
  payload: Record<string, unknown> = {},
  overrides?: { iss?: string; expSeconds?: number },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'rt-test-kid' })
    .setIssuer(overrides?.iss ?? fixture.issuer)
    .setIssuedAt()
    .setExpirationTime(`${overrides?.expSeconds ?? 60}s`)
    .sign(fixture.privateKey);
}

function makeResolver(
  table: Record<string, string | null>,
): FederatedSubjectResolver {
  return {
    resolve: async (provider: string, subject: string) => {
      const key = `${provider}:${subject}`;
      return table[key] ?? null;
    },
  };
}

describe('TokenVerifier — chemin RS256 (Keycloak)', () => {
  it('accepte un token Keycloak valide et mappe le subject vers l\'user local', async () => {
    const fixture = await buildKeycloakFixture();
    const env = makeEnv();
    const resolver = makeResolver({ 'oidc:kc-sub-alice': 'local-user-alice' });
    const verifier = new TokenVerifier(env, {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-sub-alice',
      sid: 'kc-sess-1',
    });
    const claims = await verifier.verify(token);

    expect(claims.sub).toBe('local-user-alice');
    expect(claims.sid).toBe('kc-sess-1');
  });

  it('génère un sid déterministe quand Keycloak ne fournit pas le claim', async () => {
    const fixture = await buildKeycloakFixture();
    const resolver = makeResolver({ 'oidc:kc-sub-alice': 'local-user-alice' });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });
    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-alice' });
    const claims = await verifier.verify(token);
    expect(typeof claims.sid).toBe('string');
    expect(claims.sid.length).toBeGreaterThan(0);
  });

  it('rejette un token RS256 dont l\'issuer ne correspond pas', async () => {
    const fixture = await buildKeycloakFixture();
    const resolver = makeResolver({ 'oidc:kc-sub-alice': 'local-user-alice' });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(
      fixture,
      { sub: 'kc-sub-alice' },
      { iss: 'http://attacker/realms/evil' },
    );
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejette un token RS256 dont le subject n\'a pas d\'identité fédérée', async () => {
    const fixture = await buildKeycloakFixture();
    const resolver = makeResolver({}); // aucune identité connue
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-unknown' });
    await expect(verifier.verify(token)).rejects.toThrow(/identité fédérée/);
  });

  it('rejette un token RS256 signé par une clé absente du JWKS attendu', async () => {
    const trusted = await buildKeycloakFixture();
    const attacker = await buildKeycloakFixture({ issuer: trusted.issuer });
    const resolver = makeResolver({ 'oidc:kc-sub-alice': 'local-user-alice' });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: trusted.jwks,
      issuer: trusted.issuer,
      resolver,
    });

    const token = await signKeycloakToken(attacker, { sub: 'kc-sub-alice' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejette un token RS256 quand Keycloak n\'est pas configuré', async () => {
    // Pas de bloc Keycloak injecté → l'erreur HS256 d'origine remonte.
    const fixture = await buildKeycloakFixture();
    const verifier = new TokenVerifier(makeEnv());
    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-alice' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});
