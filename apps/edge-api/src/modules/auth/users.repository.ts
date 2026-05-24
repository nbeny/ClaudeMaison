import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

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

  async findActiveByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.sql<UserRow[]>`
      SELECT id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
      FROM auth.users
      WHERE email = ${email} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findActiveById(id: string): Promise<UserRow | null> {
    const rows = await this.db.sql<UserRow[]>`
      SELECT id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
      FROM auth.users
      WHERE id = ${id} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async createWithPassword(input: {
    email: string;
    passwordHash: string;
    locale?: string;
  }): Promise<UserRow> {
    const rows = await this.db.sql<UserRow[]>`
      INSERT INTO auth.users (email, password_hash, locale)
      VALUES (${input.email}, ${input.passwordHash}, ${input.locale ?? 'fr-FR'})
      RETURNING id, email, password_hash AS "passwordHash", locale, created_at AS "createdAt"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('INSERT auth.users a renvoyé 0 ligne — incohérent.');
    }
    return row;
  }
}
