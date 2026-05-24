import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

export interface FederatedIdentityRow {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
  createdAt: Date;
  lastLogin: Date | null;
}

/**
 * Toutes les méthodes acceptent un `Sql` optionnel pour permettre l'exécution
 * dans une transaction tenue par l'appelant (cf. `DatabaseService#transaction`).
 */
@Injectable()
export class FederatedIdentitiesRepository {
  constructor(private readonly db: DatabaseService) {}

  async findByProviderSubject(
    provider: string,
    subject: string,
    tx?: SqlConn,
  ): Promise<FederatedIdentityRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<FederatedIdentityRow[]>`
      SELECT id, user_id AS "userId", provider, subject, email,
             created_at AS "createdAt", last_login AS "lastLogin"
      FROM auth.federated_identities
      WHERE provider = ${provider} AND subject = ${subject}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async create(
    input: { userId: string; provider: string; subject: string; email: string | null },
    tx?: SqlConn,
  ): Promise<FederatedIdentityRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<FederatedIdentityRow[]>`
      INSERT INTO auth.federated_identities (user_id, provider, subject, email, last_login)
      VALUES (${input.userId}, ${input.provider}, ${input.subject}, ${input.email}, now())
      RETURNING id, user_id AS "userId", provider, subject, email,
                created_at AS "createdAt", last_login AS "lastLogin"
    `;
    const row = rows[0];
    if (!row) throw new Error('INSERT auth.federated_identities a renvoyé 0 ligne.');
    return row;
  }

  async touchLastLogin(id: string, tx?: SqlConn): Promise<void> {
    const sql = tx ?? this.db.sql;
    await sql`UPDATE auth.federated_identities SET last_login = now() WHERE id = ${id}`;
  }
}
