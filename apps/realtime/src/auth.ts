import { createHash, randomUUID } from 'node:crypto';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './config/env';

// Claims minimaux nécessaires côté realtime : on n'a pas besoin de connaître
// le workspaceId à la vérification — il sera dérivé de l'abonnement WS.
export interface TokenClaims {
  sub: string;
  sid: string;
}

/**
 * Mapping (provider, subject) → userId local. Realtime n'a pas d'accès direct
 * à Postgres : en prod ce resolver est un round-trip HTTP vers edge-api
 * `/internal/auth/users/by-federated-subject`. Stub en tests.
 */
export interface FederatedSubjectResolver {
  resolve(provider: string, subject: string): Promise<string | null>;
}

export interface KeycloakVerifierConfig {
  jwks: JWTVerifyGetKey;
  issuer: string;
  resolver: FederatedSubjectResolver;
}

export class TokenVerifier {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keycloak?: KeycloakVerifierConfig;

  constructor(env: Env, keycloak?: KeycloakVerifierConfig) {
    this.key = new TextEncoder().encode(env.JWT_SIGNING_KEY);
    this.issuer = env.JWT_ISSUER;
    this.audience = env.JWT_AUDIENCE;
    this.keycloak = keycloak;
  }

  async verify(token: string): Promise<TokenClaims> {
    // 1. Tente d'abord HS256 (token natif edge-api). C'est le chemin commun
    //    une fois qu'edge-api ré-émet ses propres tokens. On préserve l'erreur
    //    d'origine pour rethrow si la voie Keycloak n'est pas configurée.
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('token missing required claims (sub, sid)');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch (localErr) {
      if (!this.keycloak) throw localErr;
    }

    // 2. Voie Keycloak RS256. Le smoke E2E utilise cette branche (le client
    //    présente directement l'access token IdP). On dérive l'user local via
    //    le resolver injecté pour pouvoir appeler l'ACL avec un userId
    //    cohérent avec ce qu'utilise edge-api.
    const { payload } = await jwtVerify(token, this.keycloak.jwks, {
      issuer: this.keycloak.issuer,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('Keycloak JWT mal formé : sub manquant.');
    }
    const userId = await this.keycloak.resolver.resolve('oidc', payload.sub);
    if (!userId) {
      throw new Error(
        `Aucune identité fédérée pour le subject Keycloak ${payload.sub}.`,
      );
    }
    // Keycloak peut ne pas exposer de `sid` dans son access token (selon la
    // version + le client). On dérive un identifiant stable du JTI ou, à
    // défaut, on en fabrique un — il n'est utilisé que pour le tracing côté
    // hub, pas pour autoriser quoi que ce soit.
    const sid = typeof payload.sid === 'string' ? payload.sid : deriveSid(payload);
    return { sub: userId, sid };
  }
}

function deriveSid(payload: Record<string, unknown>): string {
  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  if (jti) return createHash('sha256').update(jti).digest('hex').slice(0, 16);
  return randomUUID();
}
