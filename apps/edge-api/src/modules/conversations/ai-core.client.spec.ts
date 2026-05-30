import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';
import { AiCoreClient, type AiCoreTurnStreamRequest } from './ai-core.client';

// AiCoreClient est appelé en fire-and-forget depuis ConversationsService :
// le caller fait `.catch(log)` mais ne `await` pas. Conséquence : si le
// client AVALAIT silencieusement les erreurs (ex: catch{}), une panne
// ai-core deviendrait invisible (aucune erreur loggée, pas de métrique).
// Ces tests verrouillent :
//   - URL construite proprement (trailing slash strippé),
//   - body JSON + header content-type,
//   - 202 → resolve, autre status → throw avec le code dans le message,
//   - fetch lui-même qui throw → propagé tel quel (pas swallow).

const SAMPLE_REQ: AiCoreTurnStreamRequest = {
  conversationId: 'c-1',
  workspaceId: 'w-1',
  userId: 'u-1',
  messageId: 'm-asst',
  history: [{ role: 'user', content: 'salut' }],
};

function makeConfig(aiCoreUrl: string): ConfigService<Env, true> {
  return {
    get: vi.fn((key: string) => (key === 'AI_CORE_URL' ? aiCoreUrl : undefined)),
  } as unknown as ConfigService<Env, true>;
}

describe('AiCoreClient.triggerTurnStream', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('appelle POST {AI_CORE_URL}/v1/chat/turn/stream', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await client.triggerTurnStream(SAMPLE_REQ);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://ai-core:8000/v1/chat/turn/stream');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('strippe le trailing slash de AI_CORE_URL (sinon `//v1/...`)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000/'));
    await client.triggerTurnStream(SAMPLE_REQ);
    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://ai-core:8000/v1/chat/turn/stream');
  });

  it('encode le body en JSON avec content-type application/json', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await client.triggerTurnStream(SAMPLE_REQ);

    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      'content-type': 'application/json',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual(SAMPLE_REQ);
  });

  it('resolve sans throw sur 202 Accepted (le statut attendu)', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await expect(client.triggerTurnStream(SAMPLE_REQ)).resolves.toBeUndefined();
  });

  it('throw sur 200 (le contrat est 202 strict, pas any-2xx)', async () => {
    // 200 OK serait techniquement un succès HTTP mais contractuel-
    // lement ai-core renvoie 202 pour signifier "j'ai accepté, je
    // streamerai via NATS". 200 → contrat changé, on échoue fort.
    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await expect(client.triggerTurnStream(SAMPLE_REQ)).rejects.toThrow(/200/);
  });

  it('throw avec le code dans le message sur 4xx', async () => {
    fetchSpy.mockResolvedValue(new Response('bad', { status: 400 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await expect(client.triggerTurnStream(SAMPLE_REQ)).rejects.toThrow(/400/);
  });

  it('throw avec le code dans le message sur 5xx', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await expect(client.triggerTurnStream(SAMPLE_REQ)).rejects.toThrow(/503/);
  });

  it('propage l\'erreur réseau telle quelle (pas de silent swallow)', async () => {
    // CRITIQUE : si AiCoreClient catchait fetch{}, ConversationsService
    // ne pourrait pas logger l'incident (son .catch ne serait jamais
    // appelé) et la panne ai-core deviendrait invisible. Le fire-and-
    // forget compte sur le client pour propager.
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED ai-core:8000'));
    const client = new AiCoreClient(makeConfig('http://ai-core:8000'));
    await expect(client.triggerTurnStream(SAMPLE_REQ)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });
});
