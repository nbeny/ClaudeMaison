import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

@Injectable()
export class WorkspaceMembersRepository {
  constructor(private readonly db: DatabaseService) {}

  async isMember(workspaceId: string, userId: string, tx?: SqlConn): Promise<boolean> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM auth.workspace_members
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      ) AS exists
    `;
    return rows[0]?.exists === true;
  }
}
