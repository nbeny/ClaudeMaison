import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import {
  PlansRepository,
  planQuotaFor,
  type PlanRow,
} from './plans.repository';

// PlansRepository expose les plans de facturation au reste du système.
// Trois invariants critiques verrouillés :
//
//   - `listPublic` filtre `is_public = true` dans le SQL. Sans ce filtre,
//     les plans internes (beta, enterprise négocié, plan de test ops) qui
//     ne devraient pas apparaître dans le picker public seraient affichés
//     aux clients. C'est l'invariant anti-fuite-pricing-confidentiel.
//
//   - `upsert` est idempotent via `ON CONFLICT (slug) DO UPDATE`. Sert au
//     seeder qui tourne à chaque release ; il doit pouvoir réécrire les
//     valeurs si la définition évolue (ex: hausse de quota après tier
//     upgrade gratuit) sans dupliquer la ligne. EXCLUDED.* couvre 8
//     colonnes ; un oubli dans la clause UPDATE laisserait des valeurs
//     stale après seed (rétrocompat illusoire).
//
//   - `planQuotaFor` est une exhaustive switch sur UsageKind → number|null.
//     Un swap (ex: 'tool_runs' qui renvoie quota_storage_gb) ferait
//     dégager le quota du mauvais axe : tool_runs illimités quand storage
//     plein, ou tool_runs bloqués par la capacité de stockage. Le `never`
//     en defaut force la maintenance, mais n'attrape pas un swap entre
//     deux branches existantes — d'où le test.
//
// Bonus : LIMIT 1 sur findBySlug/findById, ORDER BY price ASC sur
// listPublic (UX : le plan le moins cher d'abord, fail-loud si un mainteneur
// inverse pour « mettre Pro en premier »).

type Call = { strings: TemplateStringsArray; values: unknown[] };

function makeDb(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
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

const sqlOf = (c: Call) => c.strings.join('?');

const FREE: PlanRow = {
  id: 'plan-1',
  slug: 'free',
  name: 'Free',
  description: 'Plan gratuit',
  quotaLlmTokens: 100_000,
  quotaEmbeddingsTokens: 50_000,
  quotaToolRuns: 100,
  quotaStorageGb: 1,
  priceEurMonthMicro: 0,
  isPublic: true,
};

const PRO: PlanRow = {
  ...FREE,
  id: 'plan-2',
  slug: 'pro',
  name: 'Pro',
  description: 'Plan pro',
  priceEurMonthMicro: 19_000_000,
};

describe('PlansRepository', () => {
  describe('listPublic — anti-fuite pricing confidentiel', () => {
    it('renvoie les plans publics tels que renvoyés par la DB', async () => {
      const { db } = makeDb([[FREE, PRO]]);
      const repo = new PlansRepository(db);

      const plans = await repo.listPublic();

      expect(plans).toEqual([FREE, PRO]);
    });

    it('filtre is_public = true dans le SQL', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new PlansRepository(db);

      await repo.listPublic();

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/is_public\s*=\s*true/i);
    });

    it('ORDER BY price_eur_month_micro ASC (UX prix croissant)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new PlansRepository(db);

      await repo.listPublic();

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/ORDER\s+BY\s+price_eur_month_micro\s+ASC/i);
    });

    it('tableau vide accepté (pas d\'erreur si DB sans plan)', async () => {
      const { db } = makeDb([[]]);
      const repo = new PlansRepository(db);

      const plans = await repo.listPublic();

      expect(plans).toEqual([]);
    });
  });

  describe('findBySlug — lookup paramétré', () => {
    it('retourne la ligne et LIMIT 1', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      const plan = await repo.findBySlug('free');

      expect(plan).toEqual(FREE);
      expect(sqlOf(calls[0])).toMatch(/LIMIT\s+1/i);
    });

    it('null quand aucune ligne', async () => {
      const { db } = makeDb([[]]);
      const repo = new PlansRepository(db);

      expect(await repo.findBySlug('inexistant')).toBeNull();
    });

    it('slug en valeur paramétrée (anti-injection)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new PlansRepository(db);

      const malicious = "free' OR '1'='1";
      await repo.findBySlug(malicious);

      expect(calls[0].values).toEqual([malicious]);
      expect(sqlOf(calls[0])).not.toContain("OR '1'='1");
    });

    it('utilise tx quand fourni', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.findBySlug('free', tx);

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('findById — lookup paramétré', () => {
    it('retourne la ligne et LIMIT 1', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      const plan = await repo.findById('plan-1');

      expect(plan).toEqual(FREE);
      expect(sqlOf(calls[0])).toMatch(/LIMIT\s+1/i);
    });

    it('null quand aucune ligne', async () => {
      const { db } = makeDb([[]]);
      const repo = new PlansRepository(db);

      expect(await repo.findById('nope')).toBeNull();
    });

    it('utilise tx quand fourni', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.findById('plan-1', tx);

      expect(calls).toHaveLength(1);
    });
  });

  describe('upsert — idempotence seeder', () => {
    it('ordre des valeurs INSERT verrouillé (slug, name, description, 4 quotas, price, is_public)', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({
        slug: 'free',
        name: 'Free',
        description: 'desc',
        quotaLlmTokens: 100,
        quotaEmbeddingsTokens: 50,
        quotaToolRuns: 10,
        quotaStorageGb: 1,
        priceEurMonthMicro: 0,
        isPublic: true,
      });

      expect(calls[0].values).toEqual([
        'free',
        'Free',
        'desc',
        100,
        50,
        10,
        1,
        0,
        true,
      ]);
    });

    it('contient ON CONFLICT (slug) DO UPDATE (idempotence)', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'free', name: 'Free' });

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*slug\s*\)\s+DO\s+UPDATE/i);
    });

    it('updated_at = now() dans la clause UPDATE (anti-fraîcheur trompeuse)', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'free', name: 'Free' });

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/updated_at\s*=\s*now\(\)/i);
    });

    it('UPDATE met à jour les 8 colonnes via EXCLUDED', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'free', name: 'Free' });

      const sql = sqlOf(calls[0]);
      for (const col of [
        'name',
        'description',
        'quota_llm_tokens',
        'quota_embeddings_tokens',
        'quota_tool_runs',
        'quota_storage_gb',
        'price_eur_month_micro',
        'is_public',
      ]) {
        expect(sql).toMatch(
          new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}`, 'i'),
        );
      }
    });

    it('défauts : description null, 4 quotas null, price 0, is_public true', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'free', name: 'Free' });

      expect(calls[0].values).toEqual([
        'free',
        'Free',
        null, // description
        null, // quotaLlmTokens
        null, // quotaEmbeddingsTokens
        null, // quotaToolRuns
        null, // quotaStorageGb
        0, // priceEurMonthMicro
        true, // isPublic
      ]);
    });

    it('isPublic = false explicite préservé (plan privé)', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'enterprise', name: 'Enterprise', isPublic: false });

      expect(calls[0].values[8]).toBe(false);
    });

    it('quota explicitement null (illimité) préservé', async () => {
      const { db, calls } = makeDb([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({
        slug: 'unlimited',
        name: 'Unlimited',
        quotaLlmTokens: null,
      });

      expect(calls[0].values[3]).toBeNull();
    });

    it('jette quand RETURNING renvoie 0 ligne', async () => {
      const { db } = makeDb([[]]);
      const repo = new PlansRepository(db);

      await expect(repo.upsert({ slug: 'free', name: 'Free' })).rejects.toThrow(
        /UPSERT billing\.plans/,
      );
    });

    it('utilise tx quand fourni (seeder transactionnel)', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[FREE]]);
      const repo = new PlansRepository(db);

      await repo.upsert({ slug: 'free', name: 'Free' }, tx);

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('planQuotaFor — fan-out kind → colonne', () => {
    const plan: PlanRow = {
      id: 'p',
      slug: 'mix',
      name: 'Mix',
      description: null,
      quotaLlmTokens: 1000,
      quotaEmbeddingsTokens: 2000,
      quotaToolRuns: 3000,
      quotaStorageGb: 4000,
      priceEurMonthMicro: 0,
      isPublic: true,
    };

    it('llm_tokens → quotaLlmTokens', () => {
      expect(planQuotaFor(plan, 'llm_tokens')).toBe(1000);
    });

    it('embeddings_tokens → quotaEmbeddingsTokens', () => {
      expect(planQuotaFor(plan, 'embeddings_tokens')).toBe(2000);
    });

    it('tool_runs → quotaToolRuns', () => {
      expect(planQuotaFor(plan, 'tool_runs')).toBe(3000);
    });

    it('storage_gb_day → quotaStorageGb', () => {
      expect(planQuotaFor(plan, 'storage_gb_day')).toBe(4000);
    });

    it('null préservé (quota illimité)', () => {
      const unlimited = { ...plan, quotaLlmTokens: null };
      expect(planQuotaFor(unlimited, 'llm_tokens')).toBeNull();
    });

    it('0 préservé (quota dur zéro ≠ null illimité)', () => {
      const blocked = { ...plan, quotaToolRuns: 0 };
      expect(planQuotaFor(blocked, 'tool_runs')).toBe(0);
    });
  });
});
