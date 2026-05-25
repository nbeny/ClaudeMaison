import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  buildBillingRig,
  makeAdminSql,
  resetDatabase,
  type BillingRig,
} from './helpers';
import { currentCalendarMonth } from '../../src/modules/billing/quota.service';

// Vérifie le comportement de QuotaService bout-en-bout : résolution de la
// subscription effective, calcul de `used` via SUM sur usage_events,
// arithmétique du remaining. Le piège classique (filtre temporel sur
// la période de facturation) est testé explicitement.

describe('billing quota — intégration', () => {
  const admin = makeAdminSql();
  let rig: BillingRig;

  beforeAll(async () => {
    await resetDatabase(admin);
    rig = await buildBillingRig();
  });
  beforeEach(async () => {
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await rig.db.onModuleDestroy();
    await admin.end({ timeout: 5 });
  });

  it('sans subscription, fallback sur free + mois calendaire UTC', async () => {
    const workspaceId = randomUUID(); // workspace inconnu : aucune sub
    const status = await rig.quota.check(workspaceId, 'llm_tokens');

    const free = await rig.plans.findBySlug('free');
    const { start, end } = currentCalendarMonth(new Date());

    expect(status.planSlug).toBe('free');
    expect(status.limit).toBe(free!.quotaLlmTokens);
    expect(status.used).toBe(0);
    expect(status.allowed).toBe(true);
    expect(status.periodStart.toISOString()).toBe(start.toISOString());
    expect(status.periodEnd.toISOString()).toBe(end.toISOString());
  });

  it('compte used sur la période et bloque quand limit atteint (plan free)', async () => {
    const workspaceId = randomUUID();
    const free = (await rig.plans.findBySlug('free'))!;

    // On émet exactement quotaLlmTokens tokens pour saturer le plan free.
    await rig.billing.recordUsage([
      {
        idempotencyKey: 'sat-1',
        workspaceId,
        userId: null,
        kind: 'llm_tokens',
        quantity: Number(free.quotaLlmTokens),
        unit: 'tokens',
        costEurMicro: 0,
        occurredAt: new Date(),
      },
    ]);

    const status = await rig.quota.check(workspaceId, 'llm_tokens');
    expect(status.used).toBe(Number(free.quotaLlmTokens));
    expect(status.allowed).toBe(false);
    expect(status.remaining).toBe(0);
  });

  it('avec subscription active, utilise les dates de la subscription comme période', async () => {
    // Crée un workspace + sa subscription pro. On force une période passée
    // pour vérifier que sumQuantity respecte le filtre temporel.
    const userId = (await rig.db.sql<{ id: string }[]>`
      INSERT INTO auth.users (email, password_hash)
      VALUES ('quotauser@example.test', NULL)
      RETURNING id
    `)[0].id;
    const workspaceId = (await rig.db.sql<{ id: string }[]>`
      INSERT INTO auth.workspaces (name, owner_id)
      VALUES ('test-ws', ${userId})
      RETURNING id
    `)[0].id;

    const pro = (await rig.plans.findBySlug('pro'))!;
    const periodStart = new Date('2026-04-01T00:00:00Z');
    const periodEnd = new Date('2026-05-01T00:00:00Z');
    await rig.subscriptions.create({
      workspaceId,
      planId: pro.id,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });

    // Événement dans la période courante (mai 2026) → NE doit PAS compter
    // pour le calcul du quota d'avril.
    await rig.billing.recordUsage([
      {
        idempotencyKey: 'out-of-period',
        workspaceId,
        userId: null,
        kind: 'llm_tokens',
        quantity: 1_000_000,
        unit: 'tokens',
        costEurMicro: 0,
        occurredAt: new Date('2026-05-15T12:00:00Z'),
      },
    ]);
    // Événement dans la période d'avril → DOIT compter.
    await rig.billing.recordUsage([
      {
        idempotencyKey: 'in-period',
        workspaceId,
        userId: null,
        kind: 'llm_tokens',
        quantity: 500,
        unit: 'tokens',
        costEurMicro: 0,
        occurredAt: new Date('2026-04-15T12:00:00Z'),
      },
    ]);

    const status = await rig.quota.check(workspaceId, 'llm_tokens');
    expect(status.planSlug).toBe('pro');
    expect(status.periodStart.toISOString()).toBe(periodStart.toISOString());
    expect(status.periodEnd.toISOString()).toBe(periodEnd.toISOString());
    expect(status.used).toBe(500);
    expect(status.allowed).toBe(true);
  });
});
