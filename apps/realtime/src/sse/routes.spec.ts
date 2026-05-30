import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenClaims, TokenVerifier } from '../auth';
import type { SseHub } from './hub';
import { type ConversationAcl, registerSseRoutes } from './routes';

// La route /sse/v1/conversations/:id/stream est l'unique porte d'entrée
// du flux temps réel côté client. Trois gardes en série :
//   1. token présent  → sinon 401 "missing token"
//   2. token valide   → sinon 401 "invalid token"
//   3. ACL autorise   → sinon 403 "forbidden"
// Si l'ordre est inversé (ACL appelée avant verifier) ou si hub.add
// fuit dans une early-return, on permet à un attaquant non-authentifié
// d'enregistrer un abonnement sur la conversation d'une victime.
// Ces tests verrouillent : status codes, corps de réponse, et ordre
// d'appel des dépendances.

const CLAIMS: TokenClaims = { sub: 'u-1', sid: 's-1' };
const CONVERSATION_ID = 'conv-42';

interface Deps {
  verifier: TokenVerifier;
  hub: SseHub;
  acl: ConversationAcl;
  app: FastifyInstance;
}

async function makeDeps(overrides: {
  verifyImpl?: (token: string) => Promise<TokenClaims>;
  canReadImpl?: (userId: string, conv: string) => Promise<boolean>;
} = {}): Promise<Deps> {
  const verifier = {
    verify: vi.fn(overrides.verifyImpl ?? (async () => CLAIMS)),
  } as unknown as TokenVerifier;
  const acl = {
    canRead: vi.fn(overrides.canReadImpl ?? (async () => true)),
  } as ConversationAcl;
  const hub = {
    add: vi.fn(),
    remove: vi.fn(),
    broadcast: vi.fn(),
  } as unknown as SseHub;

  const app = Fastify({ logger: false });
  registerSseRoutes(app, { verifier, hub, acl });
  await app.ready();
  return { verifier, hub, acl, app };
}

describe('SSE route — porte 1 : présence du token', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = await makeDeps();
  });
  afterEach(async () => {
    await deps.app.close();
  });

  it('401 "missing token" si la query ne contient pas de token', async () => {
    const res = await deps.app.inject({
      method: 'GET',
      url: `/sse/v1/conversations/${CONVERSATION_ID}/stream`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'missing token' });
    // CRITIQUE : ni verifier ni ACL ni hub ne doivent être touchés.
    expect(deps.verifier.verify).not.toHaveBeenCalled();
    expect(deps.acl.canRead).not.toHaveBeenCalled();
    expect(deps.hub.add).not.toHaveBeenCalled();
  });

  it('401 "missing token" si token=<empty>', async () => {
    const res = await deps.app.inject({
      method: 'GET',
      url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'missing token' });
  });
});

describe('SSE route — porte 2 : validité du token', () => {
  let deps: Deps;
  beforeEach(async () => {
    deps = await makeDeps({
      verifyImpl: async () => {
        throw new Error('signature invalide');
      },
    });
  });
  afterEach(async () => {
    await deps.app.close();
  });

  it('401 "invalid token" si verifier.verify rejette', async () => {
    const res = await deps.app.inject({
      method: 'GET',
      url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=garbage`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid token' });
    // CRITIQUE : ACL pas appelée si le token est invalide — sinon on
    // fuiterait `canRead(undefined, conversationId)` dans les logs ACL
    // et on attaquerait l'ACL par énumération d'IDs.
    expect(deps.acl.canRead).not.toHaveBeenCalled();
    expect(deps.hub.add).not.toHaveBeenCalled();
  });

  it('passe le token (pas l\'URL complète) à verifier.verify', async () => {
    await deps.app.inject({
      method: 'GET',
      url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=tok-xyz`,
    });
    expect(deps.verifier.verify).toHaveBeenCalledWith('tok-xyz');
  });
});

describe('SSE route — porte 3 : autorisation ACL', () => {
  it('403 "forbidden" si acl.canRead retourne false', async () => {
    const deps = await makeDeps({ canReadImpl: async () => false });
    try {
      const res = await deps.app.inject({
        method: 'GET',
        url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=good`,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
      // CRITIQUE : hub.add ne doit PAS avoir été appelé — sinon
      // l'attaquant recevrait les events de la victime.
      expect(deps.hub.add).not.toHaveBeenCalled();
    } finally {
      await deps.app.close();
    }
  });

  it('passe (claims.sub, conversationId) à acl.canRead', async () => {
    const deps = await makeDeps({
      verifyImpl: async () => ({ sub: 'user-zoe', sid: 's-9' }),
      canReadImpl: async () => false,
    });
    try {
      await deps.app.inject({
        method: 'GET',
        url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=good`,
      });
      expect(deps.acl.canRead).toHaveBeenCalledWith('user-zoe', CONVERSATION_ID);
    } finally {
      await deps.app.close();
    }
  });

  it('canRead reçoit l\'ID de conversation tel quel (pas d\'auto-décodage trompeur)', async () => {
    // Garde-fou : si quelqu'un décode `:conversationId` côté handler
    // via decodeURIComponent avant l'ACL, on peut introduire un
    // path-traversal-like de l'ACL côté repo. Fastify passe le param
    // déjà décodé une fois — on vérifie que ce qu'on lui donne dans
    // l'URL est ce qu'on passe à l'ACL.
    const deps = await makeDeps({ canReadImpl: async () => false });
    try {
      await deps.app.inject({
        method: 'GET',
        url: `/sse/v1/conversations/conv-with-dash/stream?token=t`,
      });
      expect(deps.acl.canRead).toHaveBeenCalledWith(CLAIMS.sub, 'conv-with-dash');
    } finally {
      await deps.app.close();
    }
  });
});

describe('SSE route — ordre des gardes', () => {
  it('verifier appelé AVANT acl (rejette token invalide sans toucher ACL)', async () => {
    const order: string[] = [];
    const deps = await makeDeps({
      verifyImpl: async () => {
        order.push('verify');
        throw new Error('bad');
      },
      canReadImpl: async () => {
        order.push('acl');
        return true;
      },
    });
    try {
      await deps.app.inject({
        method: 'GET',
        url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=t`,
      });
      // Un seul appel : verify. ACL jamais touchée parce que verify a rejeté.
      expect(order).toEqual(['verify']);
    } finally {
      await deps.app.close();
    }
  });

  it('acl appelé AVANT hub.add (refus → pas d\'enregistrement de subscription)', async () => {
    const order: string[] = [];
    const deps = await makeDeps({
      canReadImpl: async () => {
        order.push('acl');
        return false;
      },
    });
    vi.mocked(deps.hub.add).mockImplementation(() => {
      order.push('hub.add');
    });
    try {
      await deps.app.inject({
        method: 'GET',
        url: `/sse/v1/conversations/${CONVERSATION_ID}/stream?token=t`,
      });
      expect(order).toEqual(['acl']);
    } finally {
      await deps.app.close();
    }
  });
});
