import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';
import type { UsageKind } from './kinds';

export interface UsageEventInput {
  idempotencyKey: string;
  workspaceId: string;
  userId: string | null;
  kind: UsageKind;
  quantity: number;
  unit: string;
  costEurMicro: number;
  occurredAt: Date;
  metadata?: Record<string, string> | null;
}

export interface BatchInsertResult {
  accepted: number;
  duplicates: number;
}

@Injectable()
export class UsageEventsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Insère un lot d'événements d'usage avec dédoublonnage par idempotency_key.
   * Les doublons (déjà présents) sont silencieusement ignorés grâce à
   * `ON CONFLICT DO NOTHING` ; la cardinalité du RETURNING donne accepted,
   * le reste est compté en duplicates.
   *
   * L'écriture est groupée dans une transaction : tous les INSERT du lot
   * partagent la même connexion et se valident en bloc. Pour les volumes
   * attendus Jour-1 (dizaines d'événements par appel gRPC), un INSERT par
   * ligne est plus simple et plus lisible que l'helper multi-rows de
   * `postgres`, et reste largement assez performant.
   */
  async insertBatch(events: readonly UsageEventInput[]): Promise<BatchInsertResult> {
    if (events.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }

    return this.db.sql.begin(async (tx) => {
      let accepted = 0;
      for (const e of events) {
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO billing.usage_events (
            idempotency_key, workspace_id, user_id, kind,
            quantity, unit, cost_eur_micro, metadata, occurred_at
          ) VALUES (
            ${e.idempotencyKey},
            ${e.workspaceId},
            ${e.userId},
            ${e.kind},
            ${e.quantity},
            ${e.unit},
            ${e.costEurMicro},
            ${tx.json(e.metadata ?? null)},
            ${e.occurredAt}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;
        if (inserted.length > 0) accepted++;
      }
      return { accepted, duplicates: events.length - accepted };
    });
  }

  async sumQuantity(
    params: {
      workspaceId: string;
      kind: UsageKind;
      periodStart: Date;
      periodEnd: Date;
    },
    tx?: SqlConn,
  ): Promise<number> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<{ total: string | null }[]>`
      SELECT SUM(quantity)::text AS total
      FROM billing.usage_events
      WHERE workspace_id = ${params.workspaceId}
        AND kind         = ${params.kind}
        AND occurred_at >= ${params.periodStart}
        AND occurred_at <  ${params.periodEnd}
    `;
    const total = rows[0]?.total ?? null;
    // SUM(NUMERIC) revient sous forme de string par `postgres` pour préserver
    // la précision. On reconvertit en number — sur Jour-1 les magnitudes
    // restent dans la plage représentable (millions de tokens max).
    return total === null ? 0 : Number(total);
  }
}
