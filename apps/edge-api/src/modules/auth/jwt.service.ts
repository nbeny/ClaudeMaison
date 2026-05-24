import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';
import type { Env } from '../../config/env';

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
}

@Injectable()
export class JwtService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTtlSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.key = new TextEncoder().encode(
      config.get('JWT_SIGNING_KEY', { infer: true }),
    );
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
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
    const { payload } = await jwtVerify(token, this.key, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('JWT mal formé : sub ou sid manquant.');
    }
    return { sub: payload.sub, sid: payload.sid };
  }
}
