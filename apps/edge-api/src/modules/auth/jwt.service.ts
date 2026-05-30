import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '../../config/env';
import { FederatedIdentitiesRepository } from './federated-identities.repository';
import { OidcDiscoveryService } from './oidc/oidc-discovery.service';

export interface AccessTokenClaims {
  sub: string; // user id (local, auth.users.id)
  sid: string; // session id (local) ou identifiant de session Keycloak relayé tel quel
}

@Injectable()
export class JwtService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTtlSeconds: number;
  private readonly oidcClientId?: string;

  constructor(
    config: ConfigService<Env, true>,
    @Optional() private readonly discovery?: OidcDiscoveryService,
    @Optional() private readonly federatedIdentities?: FederatedIdentitiesRepository,
  ) {
    this.key = new TextEncoder().encode(config.get('JWT_SIGNING_KEY', { infer: true }));
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.oidcClientId = config.get('OIDC_CLIENT_ID', { infer: true });
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    // 1. Tente d'abord la voie locale (HS256). C'est le chemin nominal après
    //    /v1/auth/oidc/callback — on émet nos propres tokens courts liés à
    //    une session locale tracée en base.
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('JWT local mal formé : sub ou sid manquant.');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch (localErr) {
      // 2. Sans OIDC configuré, la voie locale est la seule autorisée :
      //    on rethrow l'erreur d'origine pour préserver le message.
      if (!this.discovery || !this.federatedIdentities) {
        throw localErr;
      }
    }

    // 3. Voie Keycloak RS256 : utilisée par le smoke (password grant) et
    //    par les clients qui présentent directement un access token IdP
    //    (web NextAuth Phase 1, workers headless plus tard).
    const jwks = this.discovery!.getJwks();
    const expectedIssuer = this.discovery!.getMetadata().issuer;
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('Keycloak JWT mal formé : sub manquant.');
    }
    const identity = await this.federatedIdentities!.findByProviderSubject(
      'oidc',
      payload.sub,
    );
    if (!identity) {
      throw new Error(
        `Aucune identité fédérée pour le subject Keycloak ${payload.sub}.`,
      );
    }
    const sid = typeof payload.sid === 'string' ? payload.sid : '';
    return { sub: identity.userId, sid };
  }
}
