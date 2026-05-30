import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cf. send/route.test.ts : `vi.mock` est hoisté ; ses dépendances doivent
// passer par `vi.hoisted` pour exister au moment où la factory s'exécute.
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

describe('POST /api/chat/start', () => {
  const ORIGINAL_WS = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID;

  beforeEach(() => {
    authMock.mockReset();
    requestMock.mockReset();
    gqlClientMock.mockClear();
    process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID =
      'c0c0c0c0-0000-0000-0000-000000000001';
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID = ORIGINAL_WS;
    vi.restoreAllMocks();
  });

  it('renvoie 401 sans session', async () => {
    authMock.mockResolvedValue(null);
    const resp = await POST();
    expect(resp.status).toBe(401);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('renvoie 401 sans accessToken', async () => {
    authMock.mockResolvedValue({});
    const resp = await POST();
    expect(resp.status).toBe(401);
  });

  it('renvoie 500 si NEXT_PUBLIC_DEFAULT_WORKSPACE_ID n\'est pas configuré', async () => {
    delete process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_ID;
    authMock.mockResolvedValue({ accessToken: 'tok' });
    const resp = await POST();
    expect(resp.status).toBe(500);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('passe workspaceId comme variable GraphQL et renvoie conversationId', async () => {
    authMock.mockResolvedValue({ accessToken: 'tok-xyz' });
    requestMock.mockResolvedValue({ startConversation: 'conv-42' });

    const resp = await POST();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual({ conversationId: 'conv-42' });

    expect(gqlClientMock).toHaveBeenCalledWith('tok-xyz');
    const [doc, variables] = requestMock.mock.calls[0]!;
    expect(doc).toMatch(/\$workspaceId:\s*ID!/);
    expect(variables).toEqual({
      workspaceId: 'c0c0c0c0-0000-0000-0000-000000000001',
    });
  });
});
