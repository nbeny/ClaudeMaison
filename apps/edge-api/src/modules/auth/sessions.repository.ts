import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  rotatedTo: string | null;
}

export interface NewSessionInput {
  userId: string;
  refreshTokenHash: Buffer;
  expiresAt: Date;
  userAgent?: string | null;
  ip?: string | null;
}

@Injectable()
export class SessionsRepository {
  constructor(private readonly db: DatabaseService) {}

  async create(input: NewSessionInput): Promise<SessionRow> {
    const rows = await this.db.sql<SessionRow[]>`
      INSERT INTO auth.sessions (
        user_id, refresh_token_hash, expires_at, user_agent, ip
      ) VALUES (
        ${input.userId},
        ${input.refreshTokenHash},
        ${input.expiresAt},
        ${input.userAgent ?? null},
        ${input.ip ?? null}
      )
      RETURNING id,
                user_id    AS "userId",
                expires_at AS "expiresAt",
                revoked_at AS "revokedAt",
                rotated_to AS "rotatedTo"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('INSERT auth.sessions a renvoyé 0 ligne.');
    }
    return row;
  }

  async findByRefreshHash(hash: Buffer): Promise<SessionRow | null> {
    const rows = await this.db.sql<SessionRow[]>`
      SELECT id,
             user_id    AS "userId",
             expires_at AS "expiresAt",
             revoked_at AS "revokedAt",
             rotated_to AS "rotatedTo"
      FROM auth.sessions
      WHERE refresh_token_hash = ${hash}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<SessionRow | null> {
    const rows = await this.db.sql<SessionRow[]>`
      SELECT id,
             user_id    AS "userId",
             expires_at AS "expiresAt",
             revoked_at AS "revokedAt",
             rotated_to AS "rotatedTo"
      FROM auth.sessions
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async revoke(id: string): Promise<void> {
    await this.db.sql`
      UPDATE auth.sessions
      SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL
    `;
  }

  /**
   * Détection de réutilisation : on remonte la chaîne `rotated_to` depuis la
   * session compromise jusqu'à la pointe et on révoque tout. C'est plus sûr
   * que de révoquer uniquement la session présentée — un attaquant qui a volé
   * un refresh token peut déjà l'avoir échangé contre une nouvelle paire.
   */
  async revokeChain(startSessionId: string): Promise<void> {
    await this.db.sql`
      WITH RECURSIVE chain AS (
        SELECT id, rotated_to FROM auth.sessions WHERE id = ${startSessionId}
        UNION ALL
        SELECT s.id, s.rotated_to
        FROM auth.sessions s
        JOIN chain c ON s.id = c.rotated_to
      )
      UPDATE auth.sessions
      SET revoked_at = now()
      WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL
    `;
  }

  async markRotated(oldId: string, newId: string): Promise<void> {
    await this.db.sql`
      UPDATE auth.sessions
      SET revoked_at = now(),
          rotated_to = ${newId}
      WHERE id = ${oldId}
    `;
  }

  async touch(id: string): Promise<void> {
    await this.db.sql`
      UPDATE auth.sessions SET last_used_at = now() WHERE id = ${id}
    `;
  }
}
