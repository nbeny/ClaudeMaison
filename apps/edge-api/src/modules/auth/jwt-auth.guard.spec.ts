import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenClaims, JwtService } from './jwt.service';

// JwtAuthGuard est la garde par défaut sur toutes les mutations
// GraphQL et endpoints REST user-facing. Ces tests verrouillent les
// chemins de rejet (sans token → 401) et l'injection des claims dans
// `req.user` pour @CurrentUser. Sans ce filet, un commit qui supprime
// par mégarde la branche graphql ou relâche le préfixe `Bearer ` peut
// passer en revue.

function makeJwt(claims: AccessTokenClaims, opts?: { throws?: boolean }): JwtService {
  return {
    verifyAccessToken: vi
      .fn()
      .mockImplementation(() => (opts?.throws ? Promise.reject(new Error('bad')) : Promise.resolve(claims))),
  } as unknown as JwtService;
}

function makeHttpCtx(headers: Record<string, unknown>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, unknown>; user?: AccessTokenClaims };
} {
  const req: { headers: Record<string, unknown>; user?: AccessTokenClaims } = {
    headers,
  };
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function makeGqlCtx(headers: Record<string, unknown>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, unknown>; user?: AccessTokenClaims };
} {
  const req: { headers: Record<string, unknown>; user?: AccessTokenClaims } = {
    headers,
  };
  // On simule la structure que `GqlExecutionContext.create(ctx).getContext()`
  // attend : un objet contenant `req`. La création de GqlExecutionContext
  // appelle `ctx.getArgByIndex(2)` pour le context — on stube ça.
  const gqlContext = { req };
  const ctx = {
    getType: () => 'graphql',
    getArgByIndex: (i: number) => (i === 2 ? gqlContext : undefined),
    getArgs: () => [undefined, undefined, gqlContext, undefined],
    getClass: () => class FakeResolver {},
    getHandler: () => function fakeHandler() {},
  } as unknown as ExecutionContext;
  return { ctx, req };
}

const CLAIMS: AccessTokenClaims = { sub: 'u-1', sid: 's-1' };

describe('JwtAuthGuard.canActivate — chemin HTTP', () => {
  it('laisse passer un Bearer valide et injecte les claims dans req.user', async () => {
    const jwt = makeJwt(CLAIMS);
    const { ctx, req } = makeHttpCtx({ authorization: 'Bearer good-token' });

    const guard = new JwtAuthGuard(jwt);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    expect(jwt.verifyAccessToken).toHaveBeenCalledWith('good-token');
    expect(req.user).toEqual(CLAIMS);
  });

  it('trim les espaces autour du token', async () => {
    const jwt = makeJwt(CLAIMS);
    const { ctx } = makeHttpCtx({ authorization: 'Bearer   good-token   ' });
    await new JwtAuthGuard(jwt).canActivate(ctx);
    expect(jwt.verifyAccessToken).toHaveBeenCalledWith('good-token');
  });

  it('rejette quand le header Authorization est absent', async () => {
    const jwt = makeJwt(CLAIMS);
    const { ctx } = makeHttpCtx({});
    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejette quand le header n\'a pas le préfixe Bearer', async () => {
    // Garde-fou anti-Basic/Cookie : `Basic xxx` ne doit pas être interprété
    // comme un token JWT.
    const jwt = makeJwt(CLAIMS);
    const { ctx } = makeHttpCtx({ authorization: 'Basic dXNlcjpwYXNz' });
    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejette un préfixe Bearer sans casse exacte (case-sensitive)', async () => {
    // RFC 6750 §2.1 : la valeur est "Bearer" sensible à la casse côté serveur.
    const jwt = makeJwt(CLAIMS);
    const { ctx } = makeHttpCtx({ authorization: 'bearer good-token' });
    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejette quand le JwtService refuse le token', async () => {
    const jwt = makeJwt(CLAIMS, { throws: true });
    const { ctx, req } = makeHttpCtx({ authorization: 'Bearer expired-token' });
    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    // Pas d'injection partielle de claims en cas d'échec.
    expect(req.user).toBeUndefined();
  });
});

describe('JwtAuthGuard.canActivate — chemin GraphQL', () => {
  it('extrait le req depuis le contexte GraphQL et injecte req.user', async () => {
    const jwt = makeJwt(CLAIMS);
    const { ctx, req } = makeGqlCtx({ authorization: 'Bearer good-token' });

    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual(CLAIMS);
  });

  it('rejette aussi sans Bearer côté GraphQL', async () => {
    const jwt = makeJwt(CLAIMS);
    const { ctx } = makeGqlCtx({});
    await expect(new JwtAuthGuard(jwt).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwt.verifyAccessToken).not.toHaveBeenCalled();
  });
});
