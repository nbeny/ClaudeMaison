/**
 * Caractérisation @CurrentUser — extraction du `req.user` injecté par
 * `JwtAuthGuard` à travers les deux types de contexte Nest (HTTP REST et
 * GraphQL), avec garde-fou anti-misuse.
 *
 * Le décorateur est minuscule (17 lignes), mais c'est une *frontière de
 * sécurité* : tout resolver/handler qui veut connaître l'utilisateur courant
 * passe par là. Quatre invariants critiques à figer :
 *
 *   1. Le branchement HTTP vs GraphQL doit utiliser `ctx.getType()` (et pas
 *      heuristique sur la présence de `getArgs[3]` ou autre). Une inversion
 *      silencieuse ferait que les resolvers GraphQL recevraient `undefined`
 *      systématiquement — détecté en runtime mais avec une stack trace
 *      cryptique côté Apollo.
 *
 *   2. Côté HTTP, l'extraction passe par `ctx.switchToHttp().getRequest()`
 *      (pas `ctx.getArgs()[0]` qui dépendrait de l'ordre des handlers
 *      Fastify).
 *
 *   3. Côté GraphQL, l'extraction passe par
 *      `GqlExecutionContext.create(ctx).getContext().req` — la req est dans
 *      le *context* GraphQL, pas dans le 3e arg ni dans le `info`.
 *
 *   4. Si `req.user` est absent, on jette une `Error` *générique*, PAS une
 *      `UnauthorizedException`. C'est volontaire : `req.user` absent
 *      signifie que `@CurrentUser` a été utilisé sans `@UseGuards(
 *      JwtAuthGuard)` préalable — c'est un bug de câblage, pas un échec
 *      d'auth. Renvoyer 401 masquerait le bug ; renvoyer 500 le rend
 *      visible.
 *
 * On extrait la factory via la métadonnée Nest `ROUTE_ARGS_METADATA` parce
 * que c'est la seule façon de récupérer la closure interne de
 * `createParamDecorator` sans dupliquer le code dans le test.
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { CurrentUser } from './current-user.decorator';

type ParamFactory = (data: unknown, ctx: ExecutionContext) => unknown;

/**
 * Applique `@CurrentUser()` sur une méthode bidon, puis lit la factory que
 * Nest a stockée dans la métadonnée `__routeArguments__`. C'est la même API
 * privée que Nest utilise pour résoudre les params au runtime — on s'évite
 * un faux double qui mentirait sur le comportement réel.
 */
function extractFactory(): ParamFactory {
  class Probe {
    handler(@CurrentUser() _user: unknown): void {
      // no-op
    }
  }
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { factory: ParamFactory; index: number; data: unknown }
  >;
  const entries = Object.values(meta);
  if (entries.length !== 1) {
    throw new Error(
      `Métadata __routeArguments__ inattendue : ${entries.length} entrées, attendu 1.`,
    );
  }
  return entries[0].factory;
}

function makeHttpCtx(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    switchToRpc: () => {
      throw new Error('switchToRpc ne doit pas être appelé en contexte HTTP.');
    },
    switchToWs: () => {
      throw new Error('switchToWs ne doit pas être appelé en contexte HTTP.');
    },
    // Le décorateur ne doit pas avoir besoin de ces accesseurs.
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function makeGqlCtx(request: unknown): ExecutionContext {
  // GqlExecutionContext.create(ctx) lit `ctx.getArgs()` et attend
  // `[root, args, ctxObject, info]` (4-tuple GraphQL). `ctxObject.req` est
  // ce qui sera retourné par `.getContext().req`.
  const root = {};
  const args = {};
  const ctxObject = { req: request };
  const info = {};
  return {
    getType: () => 'graphql',
    getArgs: () => [root, args, ctxObject, info],
    getArgByIndex: (i: number) => [root, args, ctxObject, info][i],
    switchToHttp: () => {
      throw new Error('switchToHttp ne doit pas être appelé en contexte GraphQL.');
    },
    switchToRpc: () => {
      throw new Error('switchToRpc ne doit pas être appelé en contexte GraphQL.');
    },
    switchToWs: () => {
      throw new Error('switchToWs ne doit pas être appelé en contexte GraphQL.');
    },
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

const SAMPLE_USER = {
  sub: 'user-42',
  sid: 'sess-abc',
  email: 'alice@example.com',
};

describe('@CurrentUser — extraction en contexte HTTP', () => {
  it('retourne req.user via ctx.switchToHttp().getRequest()', () => {
    const factory = extractFactory();
    const ctx = makeHttpCtx({ user: SAMPLE_USER });
    expect(factory(undefined, ctx)).toBe(SAMPLE_USER);
  });

  it('passe par switchToHttp() — pas par getArgs() ni getArgByIndex()', () => {
    // Si quelqu'un changeait l'impl pour faire `ctx.getArgs()[0]` (style
    // décorateur Express bas-niveau), Fastify renverrait un objet
    // différent (souvent `[reply, request]` selon le contexte) et la req
    // serait silencieusement la mauvaise. On lock l'API stricte.
    const factory = extractFactory();
    let switchCalled = false;
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => {
        switchCalled = true;
        return {
          getRequest: () => ({ user: SAMPLE_USER }),
          getResponse: () => ({}),
          getNext: () => undefined,
        };
      },
      getArgs: () => {
        throw new Error('getArgs() ne doit pas être appelé en HTTP.');
      },
      getArgByIndex: () => {
        throw new Error('getArgByIndex() ne doit pas être appelé en HTTP.');
      },
    } as unknown as ExecutionContext;
    const result = factory(undefined, ctx);
    expect(switchCalled).toBe(true);
    expect(result).toBe(SAMPLE_USER);
  });

  it("ignore l'argument `data` (pas de sélection de champ)", () => {
    // `@CurrentUser('email')` doit retourner l'user entier, pas user.email.
    // C'est volontaire : on ne donne pas une syntaxe pour piocher dans le
    // claim, parce que les claims ont une typage strict (AccessTokenClaims)
    // et un getter dynamique ferait perdre ce typage côté handler.
    const factory = extractFactory();
    const ctx = makeHttpCtx({ user: SAMPLE_USER });
    expect(factory('email', ctx)).toBe(SAMPLE_USER);
    expect(factory({ pick: 'sub' }, ctx)).toBe(SAMPLE_USER);
    expect(factory(null, ctx)).toBe(SAMPLE_USER);
  });
});

describe('@CurrentUser — extraction en contexte GraphQL', () => {
  it('retourne req.user via GqlExecutionContext.create(ctx).getContext().req', () => {
    const factory = extractFactory();
    const ctx = makeGqlCtx({ user: SAMPLE_USER });
    expect(factory(undefined, ctx)).toBe(SAMPLE_USER);
  });

  it("n'appelle PAS switchToHttp() — sinon le 3e arg GraphQL serait perdu", () => {
    // Si quelqu'un retirait le branchement `ctx.getType() === 'graphql'`,
    // l'appel tomberait sur `switchToHttp().getRequest()` qui, en contexte
    // Apollo, renverrait undefined → throw "@CurrentUser sans
    // JwtAuthGuard" alors que le guard *est* présent. Symptôme : 500
    // intermittent sur GraphQL en prod, rien en REST.
    const factory = extractFactory();
    const ctx = makeGqlCtx({ user: SAMPLE_USER });
    // makeGqlCtx jette si switchToHttp est appelé → le test échoue si la
    // branche GraphQL est cassée.
    expect(() => factory(undefined, ctx)).not.toThrow();
  });

  it('lit le 3e arg du tuple GraphQL (context), pas le 4e (info)', () => {
    // GraphQL tuple = [root, args, context, info]. `req` est dans context,
    // *pas* info. Si quelqu'un confondait info et context (les deux sont
    // des `Record<string, any>`), la req serait undefined.
    const factory = extractFactory();
    const root = {};
    const argsObj = {};
    const context = { req: { user: SAMPLE_USER } };
    const info = { req: { user: { sub: 'WRONG' } } }; // piège
    const ctx = {
      getType: () => 'graphql',
      getArgs: () => [root, argsObj, context, info],
      getArgByIndex: (i: number) => [root, argsObj, context, info][i],
      getClass: () => class {},
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;
    const result = factory(undefined, ctx) as { sub: string };
    expect(result.sub).toBe('user-42');
    expect(result.sub).not.toBe('WRONG');
  });
});

describe('@CurrentUser — anti-misuse (req.user absent)', () => {
  it('jette une Error si req.user est undefined en contexte HTTP', () => {
    const factory = extractFactory();
    const ctx = makeHttpCtx({}); // pas de .user
    expect(() => factory(undefined, ctx)).toThrowError(/JwtAuthGuard/);
  });

  it('jette une Error si req.user est undefined en contexte GraphQL', () => {
    const factory = extractFactory();
    const ctx = makeGqlCtx({}); // pas de .user
    expect(() => factory(undefined, ctx)).toThrowError(/JwtAuthGuard/);
  });

  it("jette une Error *générique*, pas une UnauthorizedException", () => {
    // Volontaire : `req.user` absent === bug de câblage côté dev (oubli de
    // `@UseGuards(JwtAuthGuard)`), pas un échec d'auth runtime. Renvoyer
    // 401 masquerait le bug et donnerait l'illusion d'un comportement
    // "auth manquante" alors que c'est le décorateur qui n'a pas son
    // contexte. On veut un 500 visible et un message explicite.
    const factory = extractFactory();
    const ctx = makeHttpCtx({});
    let caught: unknown;
    try {
      factory(undefined, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // Ne doit PAS être une UnauthorizedException Nest — on vérifie
    // l'absence d'une propriété `status` qu'aurait HttpException.
    expect((caught as Record<string, unknown>).status).toBeUndefined();
    expect((caught as Error).message).toMatch(/JwtAuthGuard/);
  });

  it('jette aussi si req.user est null (et pas seulement undefined)', () => {
    // Le check est `if (!req.user)`, donc null ET undefined doivent
    // déclencher. Régression possible si quelqu'un passait à
    // `req.user === undefined` strict pour "permettre null comme
    // sentinelle" → on lock le comportement actuel.
    const factory = extractFactory();
    const ctx = makeHttpCtx({ user: null });
    expect(() => factory(undefined, ctx)).toThrowError(/JwtAuthGuard/);
  });
});

describe('@CurrentUser — branchement strict via ctx.getType()', () => {
  it("le type 'graphql' déclenche exclusivement la branche Gql", () => {
    // Si la condition était une heuristique floue (ex: `ctx.getArgs().length === 4`),
    // un handler REST qui aurait 4 args (rare mais possible avec interceptors)
    // serait routé vers Gql et chercherait `.req` sur un objet sans req.
    // On lock la dépendance stricte au `getType()`.
    const factory = extractFactory();
    let httpCalled = false;
    let gqlGetArgsCalled = false;
    const ctx = {
      getType: () => 'graphql' as const,
      getArgs: () => {
        gqlGetArgsCalled = true;
        return [{}, {}, { req: { user: SAMPLE_USER } }, {}];
      },
      getArgByIndex: (i: number) =>
        [{}, {}, { req: { user: SAMPLE_USER } }, {}][i],
      switchToHttp: () => {
        httpCalled = true;
        return {
          getRequest: () => ({ user: { sub: 'WRONG' } }),
          getResponse: () => ({}),
          getNext: () => undefined,
        };
      },
      getClass: () => class {},
      getHandler: () => () => undefined,
    } as unknown as ExecutionContext;

    const result = factory(undefined, ctx) as { sub: string };

    expect(gqlGetArgsCalled).toBe(true);
    expect(httpCalled).toBe(false);
    expect(result.sub).toBe('user-42');
  });

  it("tout type ≠ 'graphql' tombe sur la branche HTTP", () => {
    // `getType()` peut techniquement retourner 'rpc' ou 'ws' selon le
    // transport, mais notre app n'utilise que http+graphql. La logique
    // actuelle traite tout-sauf-graphql comme HTTP. On lock ce contrat
    // pour qu'un futur ajout WS ne casse pas le décorateur silencieusement.
    const factory = extractFactory();
    const ctx = {
      getType: () => 'rpc',
      switchToHttp: () => ({
        getRequest: () => ({ user: SAMPLE_USER }),
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
    } as unknown as ExecutionContext;
    expect(factory(undefined, ctx)).toBe(SAMPLE_USER);
  });
});

describe('@CurrentUser — identité référentielle (pas de clonage)', () => {
  it("retourne la même référence d'objet que req.user, pas une copie", () => {
    // Si quelqu'un faisait `return { ...req.user }` pour "protéger" l'objet,
    // on perdrait l'identité référentielle et tous les `===` côté
    // consommateur sauteraient (notamment dans les guards qui comparent
    // `claims === req.user`). On lock l'absence de copie défensive.
    const factory = extractFactory();
    const original = { ...SAMPLE_USER };
    const ctx = makeHttpCtx({ user: original });
    expect(factory(undefined, ctx)).toBe(original);
  });
});
