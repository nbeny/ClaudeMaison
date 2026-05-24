import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../../../config/env';

/**
 * Sous-ensemble du document OIDC discovery dont on a besoin pour le flow
 * Authorization Code + verification d'ID token. On ne charge que ce qui
 * nous sert, mais on garde le brut au cas où.
 */
export interface OidcMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint?: string;
}

/**
 * Charge le document discovery au boot et expose un JWKS distant. Le JWKS
 * est mis en cache automatiquement par `jose` (refresh paresseux quand une
 * clé inconnue est rencontrée), donc une rotation de clés Keycloak est
 * transparente.
 */
@Injectable()
export class OidcDiscoveryService implements OnModuleInit {
  private readonly logger = new Logger(OidcDiscoveryService.name);
  private readonly issuerUrl: string;
  private readonly clientId: string;
  private metadata?: OidcMetadata;
  private jwks?: JWTVerifyGetKey;

  constructor(config: ConfigService<Env, true>) {
    // Le module n'est instancié que si OIDC_ISSUER_URL est défini ; cf.
    // OidcModule.register(). Donc ces deux gets ne peuvent pas être undefined.
    const issuer = config.get('OIDC_ISSUER_URL', { infer: true });
    const clientId = config.get('OIDC_CLIENT_ID', { infer: true });
    if (!issuer || !clientId) {
      throw new Error('OidcDiscoveryService instancié sans config OIDC complète.');
    }
    this.issuerUrl = issuer;
    this.clientId = clientId;
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Discovery synchrone au boot : on préfère échouer au démarrage qu'à la
   * première requête utilisateur. Si l'IdP n'est pas joignable, le pod ne
   * passe pas readiness et k8s tente un autre nœud.
   */
  private async load(): Promise<void> {
    const url = this.issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`Discovery OIDC ${res.status} ${res.statusText} sur ${url}`);
    }
    const doc = (await res.json()) as Record<string, unknown>;
    const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'];
    for (const key of required) {
      if (typeof doc[key] !== 'string') {
        throw new Error(`Discovery OIDC : champ "${key}" manquant ou non-string.`);
      }
    }
    this.metadata = {
      issuer: doc.issuer as string,
      authorizationEndpoint: doc.authorization_endpoint as string,
      tokenEndpoint: doc.token_endpoint as string,
      jwksUri: doc.jwks_uri as string,
      endSessionEndpoint:
        typeof doc.end_session_endpoint === 'string' ? doc.end_session_endpoint : undefined,
    };
    this.jwks = createRemoteJWKSet(new URL(this.metadata.jwksUri), {
      cacheMaxAge: 10 * 60 * 1_000, // 10 min, jose refresh à la demande au-delà
      cooldownDuration: 30_000,
    });
    this.logger.log(`Discovery OIDC OK pour ${this.metadata.issuer} (client ${this.clientId}).`);
  }

  getMetadata(): OidcMetadata {
    if (!this.metadata) throw new Error('Discovery OIDC pas encore chargée.');
    return this.metadata;
  }

  getJwks(): JWTVerifyGetKey {
    if (!this.jwks) throw new Error('JWKS OIDC pas encore initialisé.');
    return this.jwks;
  }
}
