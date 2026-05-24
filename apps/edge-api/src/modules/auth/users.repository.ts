import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  locale: string;
  createdAt: Date;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActiveByEmail(email: string, tx?: SqlConn): Promise<UserRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
      FROM auth.users
      WHERE email = ${email} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findActiveById(id: string, tx?: SqlConn): Promise<UserRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<UserRow[]>`
      SELECT id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
      FROM auth.users
      WHERE id = ${id} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async createWithPassword(
    input: { email: string; passwordHash: string; locale?: string },
    tx?: SqlConn,
  ): Promise<UserRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<UserRow[]>`
      INSERT INTO auth.users (email, password_hash, locale)
      VALUES (${input.email}, ${input.passwordHash}, ${input.locale ?? 'fr-FR'})
      RETURNING id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT auth.users a renvoyé 0 ligne — incohérent.');
    return row;
  }

  /**
   * Crée un user OIDC-only : pas de password_hash. La connexion locale est
   * impossible tant que l'user ne définit pas explicitement un mot de passe
   * (flow non implémenté au Jour-1).
   */
  async createPasswordless(
    input: { email: string; locale?: string },
    tx?: SqlConn,
  ): Promise<UserRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<UserRow[]>`
      INSERT INTO auth.users (email, password_hash, locale)
      VALUES (${input.email}, NULL, ${input.locale ?? 'fr-FR'})
      RETURNING id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT auth.users (passwordless) a renvoyé 0 ligne.');
    return row;
  }
}
