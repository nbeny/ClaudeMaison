import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// gqlClient est le seul point d'entrée GraphQL côté server-side Next.js.
// Toute route handler qui parle à edge-api passe par ici. Régressions
// silencieuses possibles :
//
//   - Si on changeait le scheme en 'Token' / 'JWT' / pas de scheme,
//     edge-api rejetterait en 401 silencieux côté browser (la chaîne
//     EventSource/SSE casse sans message clair).
//
//   - Si on oubliait le fallback URL et qu'on partait sur '' ou
//     'undefined', GraphQLClient construirait une URL invalide et
//     l'erreur surgirait à la première mutation, pas au démarrage.

const { gqlClientCtor } = vi.hoisted(() => ({ gqlClientCtor: vi.fn() }));

vi.mock('graphql-request', () => ({
  GraphQLClient: class {
    constructor(url: string, opts: unknown) {
      gqlClientCtor(url, opts);
    }
  },
}));

type GqlModule = typeof import('./gql');

let savedEnv: NodeJS.ProcessEnv;

async function loadFresh(): Promise<GqlModule> {
  vi.resetModules();
  return await import('./gql');
}

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.NEXT_PUBLIC_GRAPHQL_URL;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = savedEnv;
});

describe('gqlClient — URL fallback', () => {
  it('fallback à http://localhost:3000/graphql quand NEXT_PUBLIC_GRAPHQL_URL absent', async () => {
    // Sans fallback explicite, on passerait `undefined` à GraphQLClient
    // qui construit alors une URL invalide ("undefined/graphql") et
    // l'erreur n'apparaît qu'à la première mutation runtime.
    const mod = await loadFresh();
    mod.gqlClient('tok');
    const [url] = gqlClientCtor.mock.calls[0] as [string, unknown];
    expect(url).toBe('http://localhost:3000/graphql');
  });

  it('respecte NEXT_PUBLIC_GRAPHQL_URL quand fourni', async () => {
    process.env.NEXT_PUBLIC_GRAPHQL_URL = 'https://edge.example.com/graphql';
    const mod = await loadFresh();
    mod.gqlClient('tok');
    const [url] = gqlClientCtor.mock.calls[0] as [string, unknown];
    expect(url).toBe('https://edge.example.com/graphql');
  });

  it('NEXT_PUBLIC_GRAPHQL_URL vide → fallback (?? ne traite que null/undefined)', async () => {
    // process.env.X = '' est une chaîne vide, pas undefined. L'opérateur
    // ?? laisse passer '' (différent de ||). C'est documenté ici : si
    // qqn change ?? en ||, ce test révèle le drift en explicitant que
    // l'implémentation utilise ?? volontairement.
    process.env.NEXT_PUBLIC_GRAPHQL_URL = '';
    const mod = await loadFresh();
    mod.gqlClient('tok');
    const [url] = gqlClientCtor.mock.calls[0] as [string, unknown];
    expect(url).toBe('');
  });
});

describe('gqlClient — header Authorization', () => {
  it('header authorization = "Bearer <token>" exact', async () => {
    // Contrat avec edge-api/JwtAuthGuard : le scheme DOIT être 'Bearer'.
    // 'Token <jwt>' ou 'JWT <jwt>' échoueraient silencieusement en 401.
    const mod = await loadFresh();
    mod.gqlClient('eyJabc.def.ghi');
    const [, opts] = gqlClientCtor.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(opts.headers.authorization).toBe('Bearer eyJabc.def.ghi');
  });

  it('header en lower-case "authorization" (graphql-request normalise)', async () => {
    // graphql-request envoie les headers tels que fournis. La clé doit
    // rester 'authorization' (lower-case) — c'est la convention HTTP/2
    // et c'est ce que edge-api lit. Si on passait 'Authorization', le
    // comportement reste correct pour HTTP/1.1 mais devient ambigu en H2.
    const mod = await loadFresh();
    mod.gqlClient('tok');
    const [, opts] = gqlClientCtor.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(Object.keys(opts.headers)).toContain('authorization');
  });

  it('token verbatim — pas encodé, pas trimmé, pas transformé', async () => {
    // Un JWT a déjà sa structure base64url ; toute transformation
    // (URL-encode, trim, lower-case) casserait la signature et tous
    // les calls retourneraient 401.
    const dirtyToken = '  eyJ_With.Dots+Slashes/==  ';
    const mod = await loadFresh();
    mod.gqlClient(dirtyToken);
    const [, opts] = gqlClientCtor.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(opts.headers.authorization).toBe(`Bearer ${dirtyToken}`);
  });

  it('token vide → "Bearer " (pas de garde — le serveur tranche)', async () => {
    // Caractérisation : gqlClient NE valide PAS le token. C'est
    // la responsabilité du caller (route handler) de checker la session
    // avant d'appeler. Si gqlClient se mettait à throw sur token vide,
    // ça casserait les tests qui exercent le 401-path serveur.
    const mod = await loadFresh();
    mod.gqlClient('');
    const [, opts] = gqlClientCtor.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(opts.headers.authorization).toBe('Bearer ');
  });
});

describe('gqlClient — type de retour', () => {
  it('renvoie une instance de GraphQLClient', async () => {
    const mod = await loadFresh();
    const client = mod.gqlClient('tok');
    expect(client).toBeDefined();
    expect(gqlClientCtor).toHaveBeenCalledTimes(1);
  });

  it('un appel = une instance neuve (pas de cache module-level)', async () => {
    // Pas de cache = pas de partage de connexion entre requêtes.
    // C'est intentionnel : Next.js server functions sont stateless,
    // un cache process-wide casserait l'isolation entre user-sessions
    // (le token de la session A serait gardé pour la session B).
    const mod = await loadFresh();
    mod.gqlClient('tok-a');
    mod.gqlClient('tok-b');
    expect(gqlClientCtor).toHaveBeenCalledTimes(2);
    const [, optsA] = gqlClientCtor.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const [, optsB] = gqlClientCtor.mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(optsA.headers.authorization).toBe('Bearer tok-a');
    expect(optsB.headers.authorization).toBe('Bearer tok-b');
  });
});
