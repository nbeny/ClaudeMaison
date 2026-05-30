import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { InternalAuthGuard } from './internal-auth.guard';

// Le garde protège *tous* les endpoints `/internal/*` (canRead, federated
// subject resolver, …). Une régression silencieuse — par ex. quelqu'un qui
// remplace `timingSafeEqual` par `===` ou qui supprime le pre-check de
// longueur — exposerait ces endpoints à un attaquant sans secret valide.
// Ces tests verrouillent le contrat.

const SECRET = 'x'.repeat(32);

function makeConfig(secret: string = SECRET): ConfigService<Env, true> {
  return {
    get: vi.fn().mockReturnValue(secret),
  } as unknown as ConfigService<Env, true>;
}

function makeCtx(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        url: '/internal/test',
        method: 'GET',
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('InternalAuthGuard.canActivate', () => {
  it('laisse passer quand x-internal-secret correspond au secret partagé', () => {
    const guard = new InternalAuthGuard(makeConfig());
    expect(guard.canActivate(makeCtx({ 'x-internal-secret': SECRET }))).toBe(true);
  });

  it('rejette quand le header x-internal-secret est absent', () => {
    const guard = new InternalAuthGuard(makeConfig());
    expect(() => guard.canActivate(makeCtx({}))).toThrow(UnauthorizedException);
  });

  it('rejette quand le header est une string vide', () => {
    // Cas dégénéré : longueurs ≠ 32 → length check court-circuite avant
    // timingSafeEqual (qui throw sur length mismatch).
    const guard = new InternalAuthGuard(makeConfig());
    expect(() => guard.canActivate(makeCtx({ 'x-internal-secret': '' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejette un secret de bonne longueur mais valeur différente', () => {
    const guard = new InternalAuthGuard(makeConfig());
    const attacker = 'y'.repeat(SECRET.length);
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-secret': attacker })),
    ).toThrow(UnauthorizedException);
  });

  it('rejette un secret plus court (length pre-check empêche timingSafeEqual de throw)', () => {
    // Sans le length check, `timingSafeEqual` lèverait une RangeError et le
    // garde renverrait 500 au lieu d'un 401 propre.
    const guard = new InternalAuthGuard(makeConfig());
    const short = 'x'.repeat(SECRET.length - 1);
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-secret': short })),
    ).toThrow(UnauthorizedException);
  });

  it('rejette un secret plus long', () => {
    const guard = new InternalAuthGuard(makeConfig());
    const longer = 'x'.repeat(SECRET.length + 1);
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-secret': longer })),
    ).toThrow(UnauthorizedException);
  });

  it('rejette quand le header est un tableau (Fastify : header répété)', () => {
    // Si on ne checkait pas `typeof === 'string'`, `Buffer.from(['x'.repeat(32)])`
    // ferait n'importe quoi.
    const guard = new InternalAuthGuard(makeConfig());
    expect(() =>
      guard.canActivate(makeCtx({ 'x-internal-secret': [SECRET] })),
    ).toThrow(UnauthorizedException);
  });

  it('lit INTERNAL_SHARED_SECRET via ConfigService au boot', () => {
    const config = makeConfig();
    new InternalAuthGuard(config);
    expect(config.get).toHaveBeenCalledWith('INTERNAL_SHARED_SECRET', {
      infer: true,
    });
  });
});
