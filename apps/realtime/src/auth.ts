import { jwtVerify } from 'jose';
import type { Env } from './config/env';

// Claims minimaux nécessaires côté realtime : on n'a pas besoin de connaître
// le workspaceId à la vérification — il sera dérivé de l'abonnement WS.
export interface TokenClaims {
  sub: string;
  sid: string;
}

export class TokenVerifier {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(env: Env) {
    this.key = new TextEncoder().encode(env.JWT_SIGNING_KEY);
    this.issuer = env.JWT_ISSUER;
    this.audience = env.JWT_AUDIENCE;
  }

  async verify(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('token missing required claims (sub, sid)');
    }
    return { sub: payload.sub, sid: payload.sid };
  }
}
