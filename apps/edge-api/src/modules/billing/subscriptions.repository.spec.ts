import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import {
  SubscriptionsRepository,
  type SubscriptionRow,
} from './subscriptions.repository';

// SubscriptionsRepository tient la state-machine de facturation : active /
// past_due / cancelled. Trois invariants critiques verrouillés :
//
//   - `findActiveByWorkspace` filtre `status = 'active'` en dur dans le SQL.
//     Si ce filtre saute, un workspace dont l'abonnement a été annulé serait
//     vu comme « actif » par les quotas → quota service débite indéfiniment
//     un compte cancelled. C'est l'invariant anti-fuite-financière côté
//     read-path.
//
//   - `cancel` est idempotent via `WHERE id = $ AND status = 'active'`. Si
//     on supprime le filtre status, un deuxième `cancel(id)` ÉCRASE
//     `cancelled_at` avec un nouveau `now()`, ce qui détruit l'audit
//     « quand l'abonnement a-t-il été annulé pour la première fois ? ».
//     Le retour à la facturation chez le support, les questions légales,
//     les disputes RGPD reposent sur ce timestamp.
//
//   - `create` défaut `status = 'active'` : un seeder ou un test qui ne
//     passe pas explicitement le status crée bien un abonnement actif, pas
//     un objet en limbo.
//
// Mapping camelCase verrouillé sur 6 colonnes — anti-swap silencieux
// `planId` ↔ `workspaceId` (deux UUID, le type ne distingue pas).

type Call = { strings: TemplateStringsArray; values: unknown[] };

function makeDb(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    const rows = rowsPerCall[i++] ?? [];
    return Promise.resolve(rows);
  });
  return {
    db: { sql } as unknown as DatabaseService,
    sql,
    calls,
  };
}

function makeTxMock(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
  }) as unknown as SqlConn;
  return { tx, calls };
}

const sqlOf = (call: Call) => call.strings.join('?');

const ROW: SubscriptionRow = {
  id: 'sub-1',
  workspaceId: 'ws-1',
  planId: 'plan-free',
  status: 'active',
  currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
  currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
  cancelledAt: null,
};

describe('SubscriptionsRepository', () => {
  describe('findActiveByWorkspace — filtre anti-billing-cancelled', () => {
    it('retourne la ligne quand un abonnement actif existe', async () => {
      const { db, calls } = makeDb([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      const found = await repo.findActiveByWorkspace('ws-1');

      expect(found).toEqual(ROW);
      expect(calls).toHaveLength(1);
    });

    it('retourne null quand aucune ligne (anti-undefined wire)', async () => {
      const { db } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      const found = await repo.findActiveByWorkspace('ws-1');

      expect(found).toBeNull();
    });

    it("LIMIT 1 et filtre status = 'active' présents dans le SQL", async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await repo.findActiveByWorkspace('ws-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/LIMIT\s+1/i);
      expect(sql).toMatch(/status\s*=\s*'active'/i);
    });

    it('workspaceId passé en valeur paramétrée (anti-injection)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      const malicious = "'; DROP TABLE billing.subscriptions; --";
      await repo.findActiveByWorkspace(malicious);

      expect(calls[0].values).toEqual([malicious]);
      expect(sqlOf(calls[0])).not.toContain('DROP');
    });

    it('mapping camelCase verrouillé (6 colonnes)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await repo.findActiveByWorkspace('ws-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/workspace_id\s+AS\s+"workspaceId"/i);
      expect(sql).toMatch(/plan_id\s+AS\s+"planId"/i);
      expect(sql).toMatch(/current_period_start\s+AS\s+"currentPeriodStart"/i);
      expect(sql).toMatch(/current_period_end\s+AS\s+"currentPeriodEnd"/i);
      expect(sql).toMatch(/cancelled_at\s+AS\s+"cancelledAt"/i);
    });

    it('utilise tx quand fourni (atomicité signup workspace+subscription)', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      const found = await repo.findActiveByWorkspace('ws-1', tx);

      expect(found).toEqual(ROW);
      expect(calls).toHaveLength(1);
      // db.sql ne doit PAS avoir été appelé : la transaction tient
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('create — défaut status=active et bind valeurs', () => {
    it('insère et renvoie la ligne mappée', async () => {
      const { db, calls } = makeDb([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      const created = await repo.create({
        workspaceId: 'ws-1',
        planId: 'plan-free',
        currentPeriodStart: ROW.currentPeriodStart,
        currentPeriodEnd: ROW.currentPeriodEnd,
      });

      expect(created).toEqual(ROW);
      const values = calls[0].values;
      expect(values[0]).toBe('ws-1');
      expect(values[1]).toBe('plan-free');
      // status par défaut = 'active'
      expect(values[2]).toBe('active');
    });

    it("défaut 'active' uniquement quand status non fourni", async () => {
      const { db, calls } = makeDb([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      await repo.create({
        workspaceId: 'ws-1',
        planId: 'plan-free',
        status: 'past_due',
        currentPeriodStart: ROW.currentPeriodStart,
        currentPeriodEnd: ROW.currentPeriodEnd,
      });

      expect(calls[0].values[2]).toBe('past_due');
    });

    it('ordre des valeurs (workspaceId, planId, status, start, end) verrouillé', async () => {
      const { db, calls } = makeDb([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      await repo.create({
        workspaceId: 'WS',
        planId: 'PLAN',
        currentPeriodStart: new Date('2026-01-01'),
        currentPeriodEnd: new Date('2026-02-01'),
      });

      expect(calls[0].values).toEqual([
        'WS',
        'PLAN',
        'active',
        new Date('2026-01-01'),
        new Date('2026-02-01'),
      ]);
    });

    it('jette quand RETURNING renvoie 0 ligne (invariant DB rompu)', async () => {
      const { db } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await expect(
        repo.create({
          workspaceId: 'ws-1',
          planId: 'plan-free',
          currentPeriodStart: ROW.currentPeriodStart,
          currentPeriodEnd: ROW.currentPeriodEnd,
        }),
      ).rejects.toThrow(/INSERT billing\.subscriptions/);
    });

    it('utilise tx quand fourni', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[ROW]]);
      const repo = new SubscriptionsRepository(db);

      await repo.create(
        {
          workspaceId: 'ws-1',
          planId: 'plan-free',
          currentPeriodStart: ROW.currentPeriodStart,
          currentPeriodEnd: ROW.currentPeriodEnd,
        },
        tx,
      );

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('cancel — idempotent anti-écrasement cancelled_at', () => {
    it('UPDATE avec id en valeur paramétrée', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await repo.cancel('sub-1');

      expect(calls[0].values).toEqual(['sub-1']);
    });

    it("contient AND status = 'active' (idempotence dure)", async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await repo.cancel('sub-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/AND\s+status\s*=\s*'active'/i);
    });

    it("SET status = 'cancelled' et cancelled_at = now() dans le SQL", async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      await repo.cancel('sub-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/status\s*=\s*'cancelled'/i);
      expect(sql).toMatch(/cancelled_at\s*=\s*now\(\)/i);
      expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
    });

    it('ne renvoie rien (void)', async () => {
      const { db } = makeDb([[]]);
      const repo = new SubscriptionsRepository(db);

      const result = await repo.cancel('sub-1');

      expect(result).toBeUndefined();
    });
  });
});
