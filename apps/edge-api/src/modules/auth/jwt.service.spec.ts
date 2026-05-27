import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { JwtService } from './jwt.service';

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
