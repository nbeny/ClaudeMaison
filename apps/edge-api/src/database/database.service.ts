import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres, { type Sql } from 'postgres';
import type { Env } from '../config/env';

/**
 * Type acceptant le pool principal OU une transaction. Les repositories
 * prennent un `SqlConn` optionnel pour permettre à un appelant d'enrôler
 * plusieurs opérations dans la même transaction via `db.sql.begin(...)`.
 */
export type SqlConn = Sql | postgres.TransactionSql;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly sql: Sql;

  constructor(config: ConfigService<Env, true>) {
    this.sql = postgres(config.get('DATABASE_URL', { infer: true }), {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 5,
      prepare: true,
      // Postgres renvoie les TIMESTAMPTZ comme Date — bien.
      // Les identifiants restent en snake_case, on map à la main.
    });
  }

  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
