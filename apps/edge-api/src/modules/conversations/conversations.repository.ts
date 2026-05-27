import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

export interface ConversationRow {
  id: string;
  workspaceId: string;
  createdBy: string;
  title: string | null;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ConversationsRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(
    input: { workspaceId: string; createdBy: string; model?: string; title?: string },
    tx?: SqlConn,
  ): Promise<ConversationRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<ConversationRow[]>`
      INSERT INTO conversations.conversations (workspace_id, created_by, model, title)
      VALUES (${input.workspaceId}, ${input.createdBy}, ${input.model ?? null}, ${input.title ?? null})
      RETURNING id,
                workspace_id  AS "workspaceId",
                created_by    AS "createdBy",
                title, model,
                created_at    AS "createdAt",
                updated_at    AS "updatedAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT conversations.conversations a renvoyé 0 ligne.');
    return row;
  }

  async findById(id: string, tx?: SqlConn): Promise<ConversationRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<ConversationRow[]>`
      SELECT id, workspace_id AS "workspaceId", created_by AS "createdBy",
             title, model,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM conversations.conversations
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return rows[0] ?? null;
  }

  async listByWorkspace(workspaceId: string, limit = 50, tx?: SqlConn): Promise<ConversationRow[]> {
    const sql = tx ?? this.db.sql;
    return sql<ConversationRow[]>`
      SELECT id, workspace_id AS "workspaceId", created_by AS "createdBy",
             title, model,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM conversations.conversations
      WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT ${limit}
    `;
  }

  async touchUpdatedAt(id: string, tx?: SqlConn): Promise<void> {
    const sql = tx ?? this.db.sql;
    await sql`UPDATE conversations.conversations SET updated_at = now() WHERE id = ${id}`;
  }
}
