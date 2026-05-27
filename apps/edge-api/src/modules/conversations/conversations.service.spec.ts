import { describe, it, expect, vi } from 'vitest';
import { ConversationsService } from './conversations.service';
import type { AiCoreClient } from './ai-core.client';
import type { ConversationsRepository, ConversationRow } from './conversations.repository';
import type { MessagesRepository, MessageRow } from './messages.repository';

function makeConvRow(): ConversationRow {
  return {
    id: 'c1',
    workspaceId: 'w1',
    createdBy: 'u1',
    title: null,
    model: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function makeMsg(over: Partial<MessageRow>): MessageRow {
  return {
    id: 'm',
    conversationId: 'c1',
    role: 'user',
    content: '',
    finishReason: null,
    tokensIn: null,
    tokensOut: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('ConversationsService.sendMessage', () => {
  it('persiste user + placeholder assistant, touche updated_at, et déclenche ai-core en fire-and-forget', async () => {
    const conv = makeConvRow();
    const userMsg = makeMsg({ id: 'mu', role: 'user', content: 'hi' });
    const assistantMsg = makeMsg({ id: 'ma', role: 'assistant', content: '' });

    const convRepo = {
      findById: vi.fn().mockResolvedValue(conv),
      touchUpdatedAt: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationsRepository;

    const append = vi
      .fn()
      .mockResolvedValueOnce(userMsg)
      .mockResolvedValueOnce(assistantMsg);
    const listByConversation = vi.fn().mockResolvedValue([userMsg, assistantMsg]);
    const msgRepo = {
      append,
      listByConversation,
    } as unknown as MessagesRepository;

    const triggerTurnStream = vi.fn().mockResolvedValue(undefined);
    const aiCore = { triggerTurnStream } as unknown as AiCoreClient;

    const svc = new ConversationsService(convRepo, msgRepo, aiCore);
    const out = await svc.sendMessage({
      conversationId: 'c1',
      userId: 'u1',
      content: 'hi',
    });

    expect(out).toEqual({ userMessageId: 'mu', assistantMessageId: 'ma' });

    // Deux append : user puis assistant placeholder.
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, {
      conversationId: 'c1',
      role: 'user',
      content: 'hi',
    });
    expect(append).toHaveBeenNthCalledWith(2, {
      conversationId: 'c1',
      role: 'assistant',
      content: '',
    });

    expect(convRepo.touchUpdatedAt).toHaveBeenCalledWith('c1');

    // Le déclenchement ai-core est `void` — on flushe la microtask avant
    // d'inspecter le mock.
    await new Promise((r) => setImmediate(r));

    expect(triggerTurnStream).toHaveBeenCalledTimes(1);
    expect(triggerTurnStream).toHaveBeenCalledWith({
      conversationId: 'c1',
      workspaceId: 'w1',
      userId: 'u1',
      messageId: 'ma',
      model: undefined,
      history: [{ role: 'user', content: 'hi' }],
    });
  });

  it('throw NotFoundException si la conversation n’existe pas', async () => {
    const convRepo = {
      findById: vi.fn().mockResolvedValue(null),
      touchUpdatedAt: vi.fn(),
    } as unknown as ConversationsRepository;
    const msgRepo = {
      append: vi.fn(),
      listByConversation: vi.fn(),
    } as unknown as MessagesRepository;
    const aiCore = { triggerTurnStream: vi.fn() } as unknown as AiCoreClient;

    const svc = new ConversationsService(convRepo, msgRepo, aiCore);
    await expect(
      svc.sendMessage({ conversationId: 'missing', userId: 'u1', content: 'x' }),
    ).rejects.toThrow('conversation not found');
    expect(msgRepo.append).not.toHaveBeenCalled();
    expect(aiCore.triggerTurnStream).not.toHaveBeenCalled();
  });
});
