import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth.ts est le seul wrapper NextAuth du frontend. Il fait deux choses
// non-triviales :
//
//   1. Configure un Provider Keycloak avec clientId/secret/issuer depuis
//      env. Si l'un de ces 3 manque côté process.env, Keycloak()
//      reçoit `undefined!` et NextAuth pète au runtime au premier
//      signIn — pas au boot.
//
//   2. Définit deux callbacks (jwt + session) qui font transiter
//      l'access_token Keycloak depuis le `account` initial vers le
//      `session.accessToken` final. C'est ce que la route /api/chat/sse-token
//      consomme pour signer ses propres JWT internes. Si la chaîne
//      casse, le SSE retombe en 401 sans diagnostic visible.

type AuthConfig = {
  providers: Array<unknown>;
  callbacks: {
    jwt: (args: {
      token: Record<string, unknown>;
      account?: { access_token?: string } | null;
    }) => Promise<Record<string, unknown>>;
    session: (args: {
      session: Record<string, unknown>;
      token: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
  };
};

const { nextAuthCtor, keycloakCtor } = vi.hoisted(() => ({
  nextAuthCtor: vi.fn(),
  keycloakCtor: vi.fn(),
}));

vi.mock('next-auth', () => ({
  default: (config: AuthConfig) => {
    nextAuthCtor(config);
    return {
      handlers: { GET: vi.fn(), POST: vi.fn() },
      auth: vi.fn(),
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));

vi.mock('next-auth/providers/keycloak', () => ({
  default: (opts: unknown) => {
    keycloakCtor(opts);
    return { id: 'keycloak', _opts: opts };
  },
}));

let savedEnv: NodeJS.ProcessEnv;

async function loadFresh(): Promise<AuthConfig> {
  vi.resetModules();
  await import('./auth');
  return nextAuthCtor.mock.calls.at(-1)![0] as AuthConfig;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  nextAuthCtor.mockClear();
  keycloakCtor.mockClear();
  process.env.KEYCLOAK_CLIENT_ID = 'web-public';
  process.env.KEYCLOAK_CLIENT_SECRET = 'shh';
  process.env.KEYCLOAK_ISSUER = 'http://kc.test/realms/maison';
});

afterEach(() => {
  process.env = savedEnv;
});

describe('Keycloak provider config', () => {
  it('passes KEYCLOAK_CLIENT_ID from env', async () => {
    await loadFresh();
    const opts = keycloakCtor.mock.calls.at(-1)![0] as Record<string, string>;
    expect(opts.clientId).toBe('web-public');
  });

  it('passes KEYCLOAK_CLIENT_SECRET from env', async () => {
    await loadFresh();
    const opts = keycloakCtor.mock.calls.at(-1)![0] as Record<string, string>;
    expect(opts.clientSecret).toBe('shh');
  });

  it('passes KEYCLOAK_ISSUER from env', async () => {
    // L'issuer est essentiel : NextAuth fait la discovery OIDC depuis
    // cette URL. Une mauvaise issuer = découverte des endpoints
    // échoue silencieusement et l'utilisateur se retrouve sur une
    // page d'erreur générique.
    await loadFresh();
    const opts = keycloakCtor.mock.calls.at(-1)![0] as Record<string, string>;
    expect(opts.issuer).toBe('http://kc.test/realms/maison');
  });
});

describe('jwt callback', () => {
  it('propagates account.access_token to token.accessToken', async () => {
    // À l'initial sign-in, NextAuth nous donne `account` rempli (one-shot).
    // C'est notre seule occasion de capturer le token Keycloak.
    const config = await loadFresh();
    const result = await config.callbacks.jwt({
      token: { sub: 'user-1' },
      account: { access_token: 'kc-bearer-xyz' },
    });
    expect(result.accessToken).toBe('kc-bearer-xyz');
  });

  it('preserves existing token fields', async () => {
    // On ne doit PAS écraser le token NextAuth — juste lui ajouter
    // accessToken.
    const config = await loadFresh();
    const result = await config.callbacks.jwt({
      token: { sub: 'user-1', name: 'Alice' },
      account: { access_token: 'kc-bearer' },
    });
    expect(result.sub).toBe('user-1');
    expect(result.name).toBe('Alice');
  });

  it('no-ops when account is null (subsequent requests)', async () => {
    // Sur les requêtes suivantes (cookie refresh), account=null. On ne
    // doit ABSOLUMENT PAS effacer accessToken — sinon le SSE pète
    // dès le 2e tab ouvert.
    const config = await loadFresh();
    const result = await config.callbacks.jwt({
      token: { sub: 'user-1', accessToken: 'previous-bearer' },
      account: null,
    });
    expect(result.accessToken).toBe('previous-bearer');
  });

  it('no-ops when account has no access_token', async () => {
    // Cas où Keycloak renverrait juste un id_token sans access_token.
    // On garde la valeur précédente plutôt que de mettre undefined.
    const config = await loadFresh();
    const result = await config.callbacks.jwt({
      token: { sub: 'user-1', accessToken: 'previous' },
      account: {},
    });
    expect(result.accessToken).toBe('previous');
  });

  it('no-ops when account is undefined', async () => {
    const config = await loadFresh();
    const result = await config.callbacks.jwt({
      token: { sub: 'user-1', accessToken: 'previous' },
    });
    expect(result.accessToken).toBe('previous');
  });
});

describe('session callback', () => {
  it('exposes token.accessToken on session.accessToken', async () => {
    // Le contrat consommé par /api/chat/sse-token. Si on changeait
    // ce nom de champ, sse-token planterait avec 'undefined' sans
    // message explicite.
    const config = await loadFresh();
    const result = await config.callbacks.session({
      session: { user: { email: 'a@b.c' } },
      token: { accessToken: 'kc-bearer' },
    });
    expect((result as Record<string, string>).accessToken).toBe('kc-bearer');
  });

  it('preserves other session fields', async () => {
    const config = await loadFresh();
    const result = await config.callbacks.session({
      session: { user: { email: 'a@b.c' }, expires: '2099-01-01' },
      token: { accessToken: 'kc-bearer' },
    });
    expect(result.user).toEqual({ email: 'a@b.c' });
    expect(result.expires).toBe('2099-01-01');
  });

  it('writes undefined when token has no accessToken', async () => {
    // Documente le comportement : pas d'accessToken côté token →
    // session.accessToken = undefined. C'est ok pour le caller qui
    // doit gérer le cas anonyme.
    const config = await loadFresh();
    const result = await config.callbacks.session({
      session: { user: { email: 'a@b.c' } },
      token: { sub: 'user-1' },
    });
    expect((result as Record<string, unknown>).accessToken).toBeUndefined();
  });
});

describe('exports', () => {
  it('re-exports handlers, auth, signIn, signOut', async () => {
    // Casser un de ces exports = build Next.js explose puisque
    // l'API route /api/auth/[...nextauth] importe handlers.
    vi.resetModules();
    const mod = await import('./auth');
    expect(mod.handlers).toBeDefined();
    expect(mod.auth).toBeDefined();
    expect(mod.signIn).toBeDefined();
    expect(mod.signOut).toBeDefined();
  });
});
