import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` est hoisté avant les imports : les mocks doivent l'être aussi,
// d'où `vi.hoisted`. Sinon `authMock` est en TDZ quand la factory s'exécute.
const { authMock, requestMock, gqlClientMock } = vi.hoisted(() => {
  const requestMock = vi.fn();
  return {
    authMock: vi.fn(),
    requestMock,
    gqlClientMock: vi.fn(() => ({ request: requestMock })),
  };
});

vi.mock('@/lib/auth', () => ({ auth: authMock }));
vi.mock('@/lib/gql', () => ({ gqlClient: gqlClientMock }));

import { POST } from './route';

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/chat/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat/send', () => {
  beforeEach(() => {
    authMock.mockReset();
    requestMock.mockReset();
    gqlClientMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renvoie 401 quand la session est absente', async () => {
    authMock.mockResolvedValue(null);
    const resp = await POST(makeReq({ conversationId: 'c1', content: 'hi' }));
    expect(resp.status).toBe(401);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('renvoie 401 quand la session n\'a pas d\'accessToken', async () => {
    authMock.mockResolvedValue({ user: { id: 'u1' } });
    const resp = await POST(makeReq({ conversationId: 'c1', content: 'hi' }));
    expect(resp.status).toBe(401);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('renvoie 400 quand conversationId n\'est pas une string (garde-fou injection)', async () => {
    authMock.mockResolvedValue({ accessToken: 'tok' });
    const resp = await POST(makeReq({ conversationId: 42, content: 'hi' }));
    expect(resp.status).toBe(400);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('renvoie 400 quand content n\'est pas une string', async () => {
    authMock.mockResolvedValue({ accessToken: 'tok' });
    const resp = await POST(makeReq({ conversationId: 'c1', content: { evil: 1 } }));
    expect(resp.status).toBe(400);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('passe conversationId+content comme variables GraphQL (pas par interpolation)', async () => {
    authMock.mockResolvedValue({ accessToken: 'tok-xyz' });
    // Charge utile potentiellement piégée : un attaquant qui aurait pu injecter
    // via interpolation ne doit pas pouvoir altérer la query, juste passer la
    // chaîne comme valeur de variable.
    const evilContent = '"){ leak: __schema { types { name } } } #';
    requestMock.mockResolvedValue({
      sendMessage: {
        conversationId: 'c1',
        userMessageId: 'm-u',
        assistantMessageId: 'm-a',
      },
    });

    const resp = await POST(
      makeReq({ conversationId: 'c1', content: evilContent }),
    );
    expect(resp.status).toBe(200);

    expect(gqlClientMock).toHaveBeenCalledWith('tok-xyz');
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [doc, variables] = requestMock.mock.calls[0]!;
    // Le document doit déclarer les variables — pas d'interpolation directe
    // de la valeur du content dans la chaîne envoyée.
    expect(doc).toMatch(/\$conversationId:\s*ID!/);
    expect(doc).toMatch(/\$content:\s*String!/);
    expect(doc).not.toContain(evilContent);
    expect(variables).toEqual({ conversationId: 'c1', content: evilContent });
  });
});
