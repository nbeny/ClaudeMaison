import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pattern identique aux autres route handlers : vi.mock est hoisté, donc
// les références doivent passer par vi.hoisted pour exister au moment où
// la factory s'exécute (cf. apps/web/src/app/api/chat/send/route.test.ts).
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: authMock }));

import { GET } from './route';

// /api/chat/sse-token est le pont NextAuth → SSE : le client demande
// son access_token courant pour le passer en query-string à la route
// /sse/v1/conversations/:id/stream (le browser ne peut pas envoyer de
// header Authorization à l'upgrade EventSource).
//
// Invariants verrouillés :
//   - sans session → 401 (pas 200 + token vide, pas 500)
//   - session sans accessToken → 401 (pas 200 + token: undefined →
//     côté client `?token=undefined` est encore plus dangereux qu'un
//     401 propre : la query passe le check "missing token" et arrive
//     jusqu'à verifier.verify qui rejette en silence sans piste de log)
//   - happy path → 200 + {token: <verbatim>} (pas transformé, pas
//     ré-encodé, pas remplacé par un dérivé)

describe('GET /api/chat/sse-token', () => {
  beforeEach(() => {
    authMock.mockReset();
  });

  it('renvoie 401 sans session', async () => {
    authMock.mockResolvedValue(null);
    const resp = await GET();
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe('unauth');
  });

  it('renvoie 401 si session sans accessToken (pas 200 + undefined)', async () => {
    // Si on retournait 200 + {token: undefined}, le client ferait
    // EventSource(`?token=${undefined}`) → `?token=undefined`, et
    // /sse/v1/conversations/:id/stream traiterait la string littérale
    // "undefined" comme un token (échec opaque côté verifier au lieu
    // d'un 401 net côté ce handler).
    authMock.mockResolvedValue({ user: { email: 'a@x' } });
    const resp = await GET();
    expect(resp.status).toBe(401);
  });

  it('renvoie 401 si accessToken est une chaîne vide', async () => {
    authMock.mockResolvedValue({ accessToken: '' });
    const resp = await GET();
    expect(resp.status).toBe(401);
  });

  it('renvoie 200 + {token: <verbatim>} avec accessToken valide', async () => {
    authMock.mockResolvedValue({ accessToken: 'kc-access-xyz' });
    const resp = await GET();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { token: string };
    // Verbatim : pas de wrapping, pas de prefix "Bearer ", pas de
    // base64. Le client le ré-utilise directement en query string.
    expect(body.token).toBe('kc-access-xyz');
  });

  it('n\'expose pas d\'autres champs (pas de fuite de session)', async () => {
    // Si quelqu'un fait `NextResponse.json(session)` par mégarde, on
    // exposerait email, sub, et toute autre prop de la session NextAuth
    // sur un endpoint REST GET qui peut être appelé en CSRF facilement
    // (pas de mutation). On reste minimal : juste {token}.
    authMock.mockResolvedValue({
      accessToken: 'tok',
      user: { email: 'leak@x', name: 'Alice' },
      expires: '2099-01-01',
    });
    const resp = await GET();
    const body = (await resp.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['token']);
  });
});
