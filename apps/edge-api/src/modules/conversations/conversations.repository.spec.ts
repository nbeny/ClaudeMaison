import { describe, expect, it, vi } from 'vitest';
import { ConversationsRepository } from './conversations.repository';
import type { DatabaseService } from '../../database/database.service';

describe('ConversationsRepository', () => {
  it('inserts and returns the row via sql tag', async () => {
    const sqlMock = vi.fn().mockResolvedValueOnce([
      {
        id: 'c1',
        workspaceId: 'w',
        createdBy: 'u',
        title: null,
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const db = { sql: sqlMock as never } as unknown as DatabaseService;
    const repo = new ConversationsRepository(db);
    const row = await repo.create({ workspaceId: 'w', createdBy: 'u' });
    expect(row.id).toBe('c1');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
