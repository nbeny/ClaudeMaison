import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled';

export interface SubscriptionRow {
  id: string;
  workspaceId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelledAt: Date | null;
}

export interface CreateSubscriptionInput {
  workspaceId: string;
  planId: string;
  status?: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

@Injectable()
export class SubscriptionsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findActiveByWorkspace(
    workspaceId: string,
    tx?: SqlConn,
  ): Promise<SubscriptionRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<SubscriptionRow[]>`
      SELECT id,
             workspace_id          AS "workspaceId",
             plan_id               AS "planId",
             status,
             current_period_start  AS "currentPeriodStart",
             current_period_end    AS "currentPeriodEnd",
             cancelled_at          AS "cancelledAt"
      FROM billing.subscriptions
      WHERE workspace_id = ${workspaceId} AND status = 'active'
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async create(input: CreateSubscriptionInput, tx?: SqlConn): Promise<SubscriptionRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<SubscriptionRow[]>`
      INSERT INTO billing.subscriptions (
        workspace_id, plan_id, status,
        current_period_start, current_period_end
      ) VALUES (
        ${input.workspaceId},
        ${input.planId},
        ${input.status ?? 'active'},
        ${input.currentPeriodStart},
        ${input.currentPeriodEnd}
      )
      RETURNING
        id,
        workspace_id         AS "workspaceId",
        plan_id              AS "planId",
        status,
        current_period_start AS "currentPeriodStart",
        current_period_end   AS "currentPeriodEnd",
        cancelled_at         AS "cancelledAt"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('INSERT billing.subscriptions a renvoyé 0 ligne.');
    }
    return row;
  }

  async cancel(id: string): Promise<void> {
    await this.db.sql`
      UPDATE billing.subscriptions
      SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE id = ${id} AND status = 'active'
    `;
  }
}
