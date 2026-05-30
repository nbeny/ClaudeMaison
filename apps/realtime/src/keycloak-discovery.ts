import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

/**
 * Variante minimaliste de `OidcDiscoveryService` (edge-api) adaptée à
 * realtime (Fastify nu, pas de DI). Fait un fetch one-shot du document
 * discovery au boot pour récupérer l'issuer canonique et le `jwks_uri`,
 * puis instancie un JWKS distant cacheable par jose.
 *
 * Si Keycloak n'est pas joignable, on échoue au démarrage (`bootstrap`
 * propage) plutôt qu'à la première vérification de token, pour qu'un pod
 * mal configuré ne passe pas readiness.
 */
export interface KeycloakDiscovery {
  issuer: string;
  jwks: JWTVerifyGetKey;
}

export async function discoverKeycloak(issuerUrl: string): Promise<KeycloakDiscovery> {
  const url = issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Keycloak discovery ${res.status} ${res.statusText} sur ${url}`);
  }
  const doc = (await res.json()) as Record<string, unknown>;
  const issuer = doc.issuer;
  const jwksUri = doc.jwks_uri;
  if (typeof issuer !== 'string' || typeof jwksUri !== 'string') {
    throw new Error(`Keycloak discovery: champs "issuer"/"jwks_uri" manquants sur ${url}`);
  }
  return {
    issuer,
    jwks: createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30_000,
    }),
  };
}
