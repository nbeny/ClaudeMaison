import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: Date;
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  async append(
    input: { conversationId: string; role: MessageRow['role']; content: string },
    tx?: SqlConn,
  ): Promise<MessageRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<MessageRow[]>`
      INSERT INTO conversations.messages (conversation_id, role, content)
      VALUES (${input.conversationId}, ${input.role}, ${input.content})
      RETURNING id,
                conversation_id AS "conversationId",
                role, content,
                finish_reason   AS "finishReason",
                tokens_in       AS "tokensIn",
                tokens_out      AS "tokensOut",
                created_at      AS "createdAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT conversations.messages a renvoyé 0 ligne.');
    return row;
  }

  async updateAssistantFinal(
    id: string,
    content: string,
    finishReason: string,
    tokensIn: number,
    tokensOut: number,
    tx?: SqlConn,
  ): Promise<void> {
    const sql = tx ?? this.db.sql;
    await sql`
      UPDATE conversations.messages
      SET content = ${content}, finish_reason = ${finishReason},
          tokens_in = ${tokensIn}, tokens_out = ${tokensOut}
      WHERE id = ${id}
    `;
  }

  async listByConversation(conversationId: string, limit = 200, tx?: SqlConn): Promise<MessageRow[]> {
    const sql = tx ?? this.db.sql;
    return sql<MessageRow[]>`
      SELECT id, conversation_id AS "conversationId", role, content,
             finish_reason AS "finishReason",
             tokens_in     AS "tokensIn",
             tokens_out    AS "tokensOut",
             created_at    AS "createdAt"
      FROM conversations.messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at ASC LIMIT ${limit}
    `;
  }
}
