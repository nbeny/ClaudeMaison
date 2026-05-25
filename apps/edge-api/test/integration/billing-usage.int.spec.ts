import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildBillingRig, makeAdminSql, resetDatabase, type BillingRig } from './helpers';
import type { RawUsageEvent } from '../../src/modules/billing/billing.service';

// Vérifie le contrat d'idempotence : ON CONFLICT (idempotency_key) DO NOTHING
// côté SQL, traduit en {accepted, duplicates} côté service. C'est ce qui
// permet aux callers gRPC de réémettre un batch sans double-comptage.

function event(overrides: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    idempotencyKey: `evt-${randomUUID()}`,
    workspaceId: randomUUID(),
    userId: null,
    kind: 'llm_tokens',
    quantity: 100,
    unit: 'tokens',
    costEurMicro: 0,
    occurredAt: new Date(),
    metadata: null,
    ...overrides,
  };
}

describe('billing usage_events — intégration', () => {
  const admin = makeAdminSql();
  let rig: BillingRig;

  beforeAll(async () => {
    await resetDatabase(admin);
    rig = await buildBillingRig();
  });
  beforeEach(async () => {
    await resetDatabase(admin);
  });
  afterEach(async () => {
    // Re-seed après chaque test (TRUNCATE CASCADE n'a pas touché billing.plans
    // mais on l'a exclu explicitement de resetDatabase ; rien à faire ici).
  });
  afterAll(async () => {
    await rig.db.onModuleDestroy();
    await admin.end({ timeout: 5 });
  });

  it('insère un nouvel événement et compte 1 accepted, 0 duplicates', async () => {
    const e = event();
    const result = await rig.billing.recordUsage([e]);
    expect(result).toEqual({ accepted: 1, duplicates: 0 });

    const rows = await admin<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM billing.usage_events
    `;
    expect(rows[0].count).toBe('1');
  });

  it('un second appel avec la même idempotency_key est un duplicate (1 row total)', async () => {
    const e = event({ idempotencyKey: 'fixed-key', quantity: 42 });
    const first = await rig.billing.recordUsage([e]);
    expect(first).toEqual({ accepted: 1, duplicates: 0 });

    // Même clé, payload différent : la quantité ne doit PAS être mise à jour.
    const second = await rig.billing.recordUsage([{ ...e, quantity: 9999 }]);
    expect(second).toEqual({ accepted: 0, duplicates: 1 });

    const rows = await admin<{ quantity: string }[]>`
      SELECT quantity::text AS quantity FROM billing.usage_events WHERE idempotency_key='fixed-key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe('42');
  });

  it('batch mixte : accepted et duplicates comptés indépendamment', async () => {
    const seed = event({ idempotencyKey: 'k1' });
    await rig.billing.recordUsage([seed]);

    const result = await rig.billing.recordUsage([
      event({ idempotencyKey: 'k1' }), // duplicate
      event({ idempotencyKey: 'k2' }), // new
      event({ idempotencyKey: 'k3' }), // new
    ]);
    expect(result).toEqual({ accepted: 2, duplicates: 1 });
  });

  it('roundtrip JSONB metadata : on relit ce qu’on a écrit', async () => {
    const meta = { agent: 'planner', model: 'mistral-large' };
    await rig.billing.recordUsage([event({ idempotencyKey: 'with-meta', metadata: meta })]);

    const rows = await admin<{ metadata: Record<string, string> }[]>`
      SELECT metadata FROM billing.usage_events WHERE idempotency_key='with-meta'
    `;
    expect(rows[0].metadata).toEqual(meta);
  });
});
