import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMembersRepository } from '../auth/workspace-members.repository';
import { ConversationsInternalController } from './conversations-internal.controller';
import type { ConversationsRepository } from './conversations.repository';

describe('ConversationsInternalController.canRead', () => {
  it('returns canRead=true when user is member of the conversation workspace', async () => {
    const convRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'c1', workspaceId: 'w1' }),
    } as unknown as ConversationsRepository;
    const membersRepo = {
      isMember: vi.fn().mockResolvedValue(true),
    } as unknown as WorkspaceMembersRepository;

    const ctrl = new ConversationsInternalController(convRepo, membersRepo);
    const out = await ctrl.canRead('c1', 'u1');

    expect(out).toEqual({ canRead: true });
    expect(convRepo.findById).toHaveBeenCalledWith('c1');
    expect(membersRepo.isMember).toHaveBeenCalledWith('w1', 'u1');
  });

  it('returns canRead=false when conversation missing', async () => {
    const convRepo = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as ConversationsRepository;
    const membersRepo = {
      isMember: vi.fn(),
    } as unknown as WorkspaceMembersRepository;

    const ctrl = new ConversationsInternalController(convRepo, membersRepo);
    const out = await ctrl.canRead('missing', 'u1');

    expect(out).toEqual({ canRead: false });
    expect(membersRepo.isMember).not.toHaveBeenCalled();
  });
});
