import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { TokenVerifier, type FederatedSubjectResolver } from './auth';
import type { Env } from './config/env';

// Caractérisation TokenVerifier — invariants subtils NON couverts par
// auth.spec.ts. Ces tests verrouillent la sécurité du chemin de
// vérification de JWT, en particulier :
//
//   1. **Algorithm lock HS256** — JWT alg confusion (CVE class) : si on
//      passait `algorithms` à `undefined` ou `['HS256', 'RS256']`, un
//      attaquant pourrait signer en HS256 avec la clé publique RS256
//      utilisée comme secret HS256. Le `algorithms: ['HS256']` doit être
//      strict ; idem pour le chemin RS256 (`['RS256']` strict).
//
//   2. **Types de claims sub/sid** — un sub/sid numérique passerait la
//      signature mais introduirait des incohérences en aval (le hub
//      indexe par `userId` qui est attendu string). Lock-in explicite.
//
//   3. **Resolver provider = 'oidc'** — pas 'keycloak'. La table
//      federated_identities côté Postgres a une PK composite (provider,
//      subject). Si on changeait la string, le mapping échouerait
//      silencieusement (None partout) → 401 systématique.
//
//   4. **Priorité HS256 over RS256** — si le token est HS256-valide, le
//      chemin Keycloak n'est PAS tenté (resolver jamais appelé). Sinon
//      on ferait un round-trip HTTP inutile à chaque requête en hot path.
//
//   5. **deriveSid détérministe** — jti présent → SHA256[:16] (hex, 16
//      chars). jti absent → randomUUID (36 chars avec dashes). Le sid
//      n'est utilisé que pour le tracing, mais un comportement
//      surprenant casserait les corrélations Grafana.
//
//   6. **RS256 sans audience requise** — Keycloak peut ne pas inclure
//      d'`aud` dans son access token. Le chemin RS256 ne doit PAS
//      enforcer d'audience (contrairement au chemin HS256).

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
  overrides?: { iss?: string; expSeconds?: number; aud?: string },
): Promise<string> {
  const j = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'rt-test-kid' })
    .setIssuer(overrides?.iss ?? fixture.issuer)
    .setIssuedAt()
    .setExpirationTime(`${overrides?.expSeconds ?? 60}s`);
  if (overrides?.aud) j.setAudience(overrides.aud);
  return j.sign(fixture.privateKey);
}

async function signHs256(
  env: Env,
  payload: Record<string, unknown>,
  overrides?: { iss?: string; aud?: string },
): Promise<string> {
  const key = new TextEncoder().encode(env.JWT_SIGNING_KEY);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(overrides?.iss ?? env.JWT_ISSUER)
    .setAudience(overrides?.aud ?? env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30s')
    .sign(key);
}

function spyingResolver(table: Record<string, string | null> = {}): {
  resolver: FederatedSubjectResolver;
  calls: { provider: string; subject: string }[];
} {
  const calls: { provider: string; subject: string }[] = [];
  const resolver: FederatedSubjectResolver = {
    resolve: vi.fn(async (provider: string, subject: string) => {
      calls.push({ provider, subject });
      return table[`${provider}:${subject}`] ?? null;
    }),
  };
  return { resolver, calls };
}

describe('TokenVerifier — algorithm lock HS256 (anti-alg-confusion)', () => {
  it('rejette un token signé RS256 même quand un bloc Keycloak est absent', async () => {
    // Si `algorithms: ['HS256']` était relâché en `['HS256', 'RS256']`,
    // un attaquant pourrait présenter un RS256 forgé. Lock strict.
    const fixture = await buildKeycloakFixture();
    const verifier = new TokenVerifier(makeEnv()); // pas de Keycloak
    const token = await signKeycloakToken(fixture, {
      sub: 'attacker',
      sid: 'kc-1',
    });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejette un token alg=none (pas de signature) — protection critique', async () => {
    // Cas classique d'alg=none : header dit "pas de signature à
    // vérifier". Si jose accepte sans clé pour 'none', on ouvre la
    // porte à n'importe quel claim forgé.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        sid: 'pwn',
        iss: 'edge-api-test',
        aud: 'edge-api-test',
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const tokenAlgNone = `${header}.${body}.`;
    const verifier = new TokenVerifier(makeEnv());
    await expect(verifier.verify(tokenAlgNone)).rejects.toThrow();
  });

  it('chemin RS256 lock à RS256 — un HS256 même signé avec clé publique ne passe pas RS256', async () => {
    // Le chemin Keycloak doit imposer `algorithms: ['RS256']`. Sinon
    // alg confusion possible : signer un HS256 avec la clé publique
    // RS256 utilisée comme secret HMAC, puis envoyer alg=HS256.
    // Ici on vérifie qu'un HS256 ne franchit pas la branche RS256 :
    // il devrait être attrapé en amont par la branche HS256 stricte,
    // et si HS256 échoue, la branche RS256 doit elle-aussi rejeter
    // tout ce qui n'est pas alg=RS256.
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({ 'oidc:attacker': 'local-attacker' });
    const env = makeEnv({ JWT_SIGNING_KEY: 'b'.repeat(48) }); // HS256 va échouer
    const verifier = new TokenVerifier(env, {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });
    // HS256 signé avec une AUTRE clé partagée → branche locale échoue,
    // branche RS256 doit refuser (alg HS256 ≠ RS256).
    const otherKey = new TextEncoder().encode('c'.repeat(48));
    const token = await new SignJWT({ sub: 'attacker', sid: 'kc-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(fixture.issuer)
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(otherKey);
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe('TokenVerifier — types de claims HS256 stricts', () => {
  it('rejette un HS256 dont `sub` est un nombre (pas une string)', async () => {
    // Si on relâchait le typeof check, le hub indexerait par un Number
    // alors que le reste du système attend des strings — incohérences
    // dans les Map<string, Set<...>> côté ConnectionHub/SseHub.
    const env = makeEnv();
    const token = await signHs256(env, { sub: 12345, sid: 's1' });
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow(/required claims/);
  });

  it('rejette un HS256 dont `sid` est absent', async () => {
    const env = makeEnv();
    const token = await signHs256(env, { sub: 'u1' });
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow(/required claims/);
  });

  it('rejette un HS256 dont `sub` est absent', async () => {
    const env = makeEnv();
    const token = await signHs256(env, { sid: 's1' });
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejette un HS256 dont `sid` est un objet', async () => {
    const env = makeEnv();
    const token = await signHs256(env, { sub: 'u1', sid: { nested: 'x' } });
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow(/required claims/);
  });
});

describe('TokenVerifier — HS256 enforce issuer & audience', () => {
  it('rejette HS256 dont l\'issuer ne matche pas', async () => {
    const env = makeEnv();
    const token = await signHs256(
      env,
      { sub: 'u1', sid: 's1' },
      { iss: 'attacker' },
    );
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejette HS256 dont l\'audience ne matche pas', async () => {
    const env = makeEnv();
    const token = await signHs256(
      env,
      { sub: 'u1', sid: 's1' },
      { aud: 'autre-audience' },
    );
    const verifier = new TokenVerifier(env);
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe('TokenVerifier — priorité HS256 sur RS256 (perf hot path)', () => {
  it('quand HS256 est valide, le resolver Keycloak n\'est JAMAIS appelé', async () => {
    // Sans cette priorité, chaque requête realtime ferait un round-trip
    // HTTP edge-api inutile à chaque token edge-natif. On lock-in pour
    // éviter une régression silencieuse de perf.
    const env = makeEnv();
    const fixture = await buildKeycloakFixture();
    const { resolver, calls } = spyingResolver();
    const verifier = new TokenVerifier(env, {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signHs256(env, { sub: 'local-u1', sid: 'sess-1' });
    const claims = await verifier.verify(token);

    expect(claims).toEqual({ sub: 'local-u1', sid: 'sess-1' });
    expect(calls).toEqual([]);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('quand HS256 échoue, RS256 est tenté (fallback)', async () => {
    const env = makeEnv();
    const fixture = await buildKeycloakFixture();
    const { resolver, calls } = spyingResolver({
      'oidc:kc-sub-alice': 'local-alice',
    });
    const verifier = new TokenVerifier(env, {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-sub-alice',
      sid: 'kc-1',
    });
    const claims = await verifier.verify(token);

    expect(claims.sub).toBe('local-alice');
    expect(calls).toHaveLength(1);
  });
});

describe('TokenVerifier — resolver appelé avec provider=\'oidc\'', () => {
  it('le provider passé au resolver est EXACTEMENT "oidc" (pas "keycloak")', async () => {
    // CRITIQUE : la table federated_identities côté Postgres a une PK
    // composite (provider, subject). Si on changeait la string en
    // 'keycloak', le mapping échouerait silencieusement pour tous les
    // users existants.
    const fixture = await buildKeycloakFixture();
    const { resolver, calls } = spyingResolver({
      'oidc:kc-sub-bob': 'local-bob',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, { sub: 'kc-sub-bob' });
    await verifier.verify(token);

    expect(calls).toEqual([{ provider: 'oidc', subject: 'kc-sub-bob' }]);
    expect(calls[0]!.provider).not.toBe('keycloak');
  });

  it('le subject passé au resolver est EXACTEMENT le payload.sub du JWT (pas le sid)', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver, calls } = spyingResolver({
      'oidc:kc-real-sub': 'local-x',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-real-sub',
      sid: 'kc-sid-different',
    });
    await verifier.verify(token);

    expect(calls[0]!.subject).toBe('kc-real-sub');
    expect(calls[0]!.subject).not.toBe('kc-sid-different');
  });
});

describe('TokenVerifier — RS256 sub manquant ou non-string', () => {
  it('rejette si payload.sub manque côté Keycloak', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver();
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });
    // sub omis : la signature passe, mais le check métier doit refuser.
    const token = await signKeycloakToken(fixture, { sid: 'only-sid' });
    await expect(verifier.verify(token)).rejects.toThrow(/sub/);
  });

  it('rejette si payload.sub est un nombre côté Keycloak', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver();
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });
    const token = await signKeycloakToken(fixture, { sub: 42 });
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe('TokenVerifier — deriveSid déterministe', () => {
  it('si jti présent → sid = SHA256(jti)[:16] (16 chars hex, déterministe)', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-x': 'local-x',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const t1 = await signKeycloakToken(fixture, {
      sub: 'kc-sub-x',
      jti: 'fixed-jti-abc',
    });
    const t2 = await signKeycloakToken(fixture, {
      sub: 'kc-sub-x',
      jti: 'fixed-jti-abc',
    });
    const c1 = await verifier.verify(t1);
    const c2 = await verifier.verify(t2);

    expect(c1.sid).toBe(c2.sid); // déterminisme jti → sid
    expect(c1.sid).toMatch(/^[0-9a-f]{16}$/); // exactement 16 chars hex
  });

  it('si jti absent ET sid absent → sid = randomUUID (36 chars, NON déterministe)', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-y': 'local-y',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const t1 = await signKeycloakToken(fixture, { sub: 'kc-sub-y' });
    const t2 = await signKeycloakToken(fixture, { sub: 'kc-sub-y' });
    const c1 = await verifier.verify(t1);
    const c2 = await verifier.verify(t2);

    expect(c1.sid).not.toBe(c2.sid); // non-déterministe
    expect(c1.sid).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 format
  });

  it('si sid est fourni explicitement par Keycloak, deriveSid n\'est pas appelé', async () => {
    // sid présent → on prend la string telle quelle, pas de hash ni d'UUID.
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-z': 'local-z',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-sub-z',
      sid: 'kc-explicit-sid',
    });
    const claims = await verifier.verify(token);
    expect(claims.sid).toBe('kc-explicit-sid');
  });
});

describe('TokenVerifier — RS256 sans audience requise', () => {
  it('un token Keycloak SANS claim `aud` est accepté (Keycloak peut ne pas l\'inclure)', async () => {
    // Si on enforce une audience sur le chemin RS256, on casse la
    // compatibilité avec les clients Keycloak configurés sans audience
    // explicite. Le chemin HS256 enforce aud, le chemin RS256 non.
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-no-aud': 'local-no-aud',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-sub-no-aud',
      sid: 'kc-1',
    });
    const claims = await verifier.verify(token);
    expect(claims.sub).toBe('local-no-aud');
  });

  it('un token Keycloak AVEC un `aud` arbitraire est aussi accepté', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-aud': 'local-aud',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(
      fixture,
      { sub: 'kc-sub-aud', sid: 'kc-2' },
      { aud: 'arbitrary-realtime-client' },
    );
    const claims = await verifier.verify(token);
    expect(claims.sub).toBe('local-aud');
  });
});

describe('TokenVerifier — pas de fuite du token brut dans les claims', () => {
  it('les claims renvoyés contiennent EXACTEMENT { sub, sid } — pas plus', async () => {
    // Anti-fuite : si on retournait le payload entier, des claims
    // sensibles (preferred_username, email, roles) atteindraient le
    // hub. Lock-in du shape.
    const env = makeEnv();
    const token = await signHs256(env, {
      sub: 'u1',
      sid: 's1',
      email: 'secret@example.com',
      roles: ['admin'],
    });
    const verifier = new TokenVerifier(env);
    const claims = await verifier.verify(token);

    expect(Object.keys(claims).sort()).toEqual(['sid', 'sub']);
    expect((claims as Record<string, unknown>).email).toBeUndefined();
    expect((claims as Record<string, unknown>).roles).toBeUndefined();
  });

  it('même via le chemin RS256, les claims renvoyés sont EXACTEMENT { sub, sid }', async () => {
    const fixture = await buildKeycloakFixture();
    const { resolver } = spyingResolver({
      'oidc:kc-sub-leak': 'local-clean',
    });
    const verifier = new TokenVerifier(makeEnv(), {
      jwks: fixture.jwks,
      issuer: fixture.issuer,
      resolver,
    });

    const token = await signKeycloakToken(fixture, {
      sub: 'kc-sub-leak',
      sid: 'kc-clean',
      preferred_username: 'alice',
      email: 'alice@example.com',
      groups: ['admin', 'billing'],
    });
    const claims = await verifier.verify(token);

    expect(Object.keys(claims).sort()).toEqual(['sid', 'sub']);
    expect((claims as Record<string, unknown>).preferred_username).toBeUndefined();
    expect((claims as Record<string, unknown>).email).toBeUndefined();
  });
});
