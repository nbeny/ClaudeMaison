import { Injectable } from '@nestjs/common';
import { DatabaseService, type SqlConn } from '../../database/database.service';
import type { UsageKind } from './kinds';
import { PLAN_QUOTA_COLUMN } from './kinds';

export interface PlanRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  quotaLlmTokens: number | null;
  quotaEmbeddingsTokens: number | null;
  quotaToolRuns: number | null;
  quotaStorageGb: number | null;
  priceEurMonthMicro: number;
  isPublic: boolean;
}

export interface UpsertPlanInput {
  slug: string;
  name: string;
  description?: string;
  quotaLlmTokens?: number | null;
  quotaEmbeddingsTokens?: number | null;
  quotaToolRuns?: number | null;
  quotaStorageGb?: number | null;
  priceEurMonthMicro?: number;
  isPublic?: boolean;
}

@Injectable()
export class PlansRepository {
  constructor(private readonly db: DatabaseService) {}

  async listPublic(): Promise<PlanRow[]> {
    return this.db.sql<PlanRow[]>`
      SELECT id,
             slug,
             name,
             description,
             quota_llm_tokens        AS "quotaLlmTokens",
             quota_embeddings_tokens AS "quotaEmbeddingsTokens",
             quota_tool_runs         AS "quotaToolRuns",
             quota_storage_gb        AS "quotaStorageGb",
             price_eur_month_micro   AS "priceEurMonthMicro",
             is_public               AS "isPublic"
      FROM billing.plans
      WHERE is_public = true
      ORDER BY price_eur_month_micro ASC
    `;
  }

  async findBySlug(slug: string, tx?: SqlConn): Promise<PlanRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<PlanRow[]>`
      SELECT id,
             slug,
             name,
             description,
             quota_llm_tokens        AS "quotaLlmTokens",
             quota_embeddings_tokens AS "quotaEmbeddingsTokens",
             quota_tool_runs         AS "quotaToolRuns",
             quota_storage_gb        AS "quotaStorageGb",
             price_eur_month_micro   AS "priceEurMonthMicro",
             is_public               AS "isPublic"
      FROM billing.plans
      WHERE slug = ${slug}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async findById(id: string, tx?: SqlConn): Promise<PlanRow | null> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<PlanRow[]>`
      SELECT id,
             slug,
             name,
             description,
             quota_llm_tokens        AS "quotaLlmTokens",
             quota_embeddings_tokens AS "quotaEmbeddingsTokens",
             quota_tool_runs         AS "quotaToolRuns",
             quota_storage_gb        AS "quotaStorageGb",
             price_eur_month_micro   AS "priceEurMonthMicro",
             is_public               AS "isPublic"
      FROM billing.plans
      WHERE id = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  // Upsert idempotent : sert au seed des plans par défaut. Met à jour les
  // colonnes nommées si la slug existe déjà — on autorise le seeder à
  // corriger des valeurs si la définition évolue entre deux releases.
  async upsert(input: UpsertPlanInput, tx?: SqlConn): Promise<PlanRow> {
    const sql = tx ?? this.db.sql;
    const rows = await sql<PlanRow[]>`
      INSERT INTO billing.plans (
        slug, name, description,
        quota_llm_tokens, quota_embeddings_tokens,
        quota_tool_runs, quota_storage_gb,
        price_eur_month_micro, is_public
      ) VALUES (
        ${input.slug},
        ${input.name},
        ${input.description ?? null},
        ${input.quotaLlmTokens ?? null},
        ${input.quotaEmbeddingsTokens ?? null},
        ${input.quotaToolRuns ?? null},
        ${input.quotaStorageGb ?? null},
        ${input.priceEurMonthMicro ?? 0},
        ${input.isPublic ?? true}
      )
      ON CONFLICT (slug) DO UPDATE SET
        name                    = EXCLUDED.name,
        description             = EXCLUDED.description,
        quota_llm_tokens        = EXCLUDED.quota_llm_tokens,
        quota_embeddings_tokens = EXCLUDED.quota_embeddings_tokens,
        quota_tool_runs         = EXCLUDED.quota_tool_runs,
        quota_storage_gb        = EXCLUDED.quota_storage_gb,
        price_eur_month_micro   = EXCLUDED.price_eur_month_micro,
        is_public               = EXCLUDED.is_public,
        updated_at              = now()
      RETURNING
        id,
        slug,
        name,
        description,
        quota_llm_tokens        AS "quotaLlmTokens",
        quota_embeddings_tokens AS "quotaEmbeddingsTokens",
        quota_tool_runs         AS "quotaToolRuns",
        quota_storage_gb        AS "quotaStorageGb",
        price_eur_month_micro   AS "priceEurMonthMicro",
        is_public               AS "isPublic"
    `;
    const row = rows[0];
    if (!row) {
      throw new Error('UPSERT billing.plans a renvoyé 0 ligne — incohérent.');
    }
    return row;
  }
}

export function planQuotaFor(plan: PlanRow, kind: UsageKind): number | null {
  switch (kind) {
    case 'llm_tokens':
      return plan.quotaLlmTokens;
    case 'embeddings_tokens':
      return plan.quotaEmbeddingsTokens;
    case 'tool_runs':
      return plan.quotaToolRuns;
    case 'storage_gb_day':
      return plan.quotaStorageGb;
    default: {
      // Vérification exhaustive : si on ajoute un kind sans mettre à jour
      // cette fonction, le compilateur le détecte. La colonne associée est
      // référencée pour bloquer une suppression accidentelle.
      const _exhaustive: never = kind;
      void PLAN_QUOTA_COLUMN[_exhaustive];
      return null;
    }
  }
}
