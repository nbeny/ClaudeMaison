import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlansSeeder } from './plans.seeder';
import type { PlansRepository } from './plans.repository';

// PlansSeeder est exécuté UNE FOIS au boot via onApplicationBootstrap.
// Il porte le contrat tarifaire jour-1 :
//
//   - free   : 200k LLM, 100k embeddings, 50 tool runs, 1 GB,  0 €,    public
//   - pro    : 5M  LLM, 5M  embeddings, 2k tool runs, 50 GB, 25 €,    public
//   - ent.   : -1 (illimité partout), 0 € (devis), NON public
//
// Les invariants critiques :
//
//   - 3 plans et pas plus : l'ajout d'un 4e plan = décision business à
//     valider, pas un commit silencieux. Le test garde le plafond.
//
//   - Quotas en valeur exacte : un ajustement à la baisse change le
//     contrat utilisateur (free → 100k LLM serait une régression
//     silencieuse). Un changement de prix non-validé est encore pire.
//
//   - Enterprise = -1 partout = sentinelle « illimité » côté
//     PlansRepository (cf. planQuotaFor). Si on perdait le -1, les
//     clients enterprise seraient brutalement quotaisés.
//
//   - Enterprise.isPublic = false : empêche /api/plans publics
//     d'exposer un plan dont le prix n'est pas affiché. Une régression
//     ici fait fuiter la stratégie commerciale.
//
//   - L'ordre d'upsert (free, pro, enterprise) n'a pas d'importance
//     fonctionnelle (upsert idempotent) mais reste verrouillé pour
//     lisibilité et reproductibilité du seed.

function makeSeeder(): {
  seeder: PlansSeeder;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn().mockResolvedValue(undefined);
  const repo = { upsert } as unknown as PlansRepository;
  return { seeder: new PlansSeeder(repo), upsert };
}

interface SeededPlan {
  slug: string;
  name: string;
  quotaLlmTokens: number;
  quotaEmbeddingsTokens: number;
  quotaToolRuns: number;
  quotaStorageGb: number;
  priceEurMonthMicro: number;
  isPublic: boolean;
}

describe('PlansSeeder', () => {
  let seeder: PlansSeeder;
  let upsert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ seeder, upsert } = makeSeeder());
  });

  describe('boot', () => {
    it('seed exactement 3 plans (pas 2, pas 4)', async () => {
      await seeder.onApplicationBootstrap();

      expect(upsert).toHaveBeenCalledTimes(3);
    });

    it('seed dans l\'ordre free → pro → enterprise', async () => {
      await seeder.onApplicationBootstrap();

      const slugs = upsert.mock.calls.map((c) => (c[0] as SeededPlan).slug);
      expect(slugs).toEqual(['free', 'pro', 'enterprise']);
    });

    it('propage l\'erreur si upsert rejette (boot doit échouer fort)', async () => {
      upsert.mockRejectedValueOnce(new Error('db down'));

      await expect(seeder.onApplicationBootstrap()).rejects.toThrow('db down');
    });
  });

  describe('plan FREE — quotas serrés, gratuit, public', () => {
    it('quotas en valeurs exactes', async () => {
      await seeder.onApplicationBootstrap();
      const free = upsert.mock.calls[0]![0] as SeededPlan;

      expect(free.slug).toBe('free');
      expect(free.name).toBe('Free');
      expect(free.quotaLlmTokens).toBe(200_000);
      expect(free.quotaEmbeddingsTokens).toBe(100_000);
      expect(free.quotaToolRuns).toBe(50);
      expect(free.quotaStorageGb).toBe(1);
    });

    it('prix = 0 et public', async () => {
      await seeder.onApplicationBootstrap();
      const free = upsert.mock.calls[0]![0] as SeededPlan;

      expect(free.priceEurMonthMicro).toBe(0);
      expect(free.isPublic).toBe(true);
    });
  });

  describe('plan PRO — usage intensif, payant, public', () => {
    it('quotas en valeurs exactes', async () => {
      await seeder.onApplicationBootstrap();
      const pro = upsert.mock.calls[1]![0] as SeededPlan;

      expect(pro.slug).toBe('pro');
      expect(pro.name).toBe('Pro');
      expect(pro.quotaLlmTokens).toBe(5_000_000);
      expect(pro.quotaEmbeddingsTokens).toBe(5_000_000);
      expect(pro.quotaToolRuns).toBe(2_000);
      expect(pro.quotaStorageGb).toBe(50);
    });

    it('prix = 25 €/mois en micros (25_000_000) et public', async () => {
      await seeder.onApplicationBootstrap();
      const pro = upsert.mock.calls[1]![0] as SeededPlan;

      expect(pro.priceEurMonthMicro).toBe(25_000_000);
      expect(pro.isPublic).toBe(true);
    });
  });

  describe('plan ENTERPRISE — illimité, sur devis, NON public', () => {
    it('quotas -1 partout (sentinelle illimité)', async () => {
      await seeder.onApplicationBootstrap();
      const ent = upsert.mock.calls[2]![0] as SeededPlan;

      expect(ent.slug).toBe('enterprise');
      expect(ent.name).toBe('Enterprise');
      expect(ent.quotaLlmTokens).toBe(-1);
      expect(ent.quotaEmbeddingsTokens).toBe(-1);
      expect(ent.quotaToolRuns).toBe(-1);
      expect(ent.quotaStorageGb).toBe(-1);
    });

    it('prix = 0 (tarification commerciale) ET isPublic = false', async () => {
      await seeder.onApplicationBootstrap();
      const ent = upsert.mock.calls[2]![0] as SeededPlan;

      expect(ent.priceEurMonthMicro).toBe(0);
      // anti-fuite : enterprise ne doit JAMAIS apparaître sur la page publique
      expect(ent.isPublic).toBe(false);
    });
  });

  describe('garde-fous globaux', () => {
    it('chaque plan a un slug, un name et une description non vides', async () => {
      await seeder.onApplicationBootstrap();

      for (const call of upsert.mock.calls) {
        const plan = call[0] as SeededPlan & { description: string };
        expect(plan.slug).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(plan.name.length).toBeGreaterThan(0);
        expect(plan.description.length).toBeGreaterThan(0);
      }
    });

    it('aucun plan public avec prix = 0 ET quotas illimités (= free déguisé en pro)', async () => {
      // Garde-fou business : un plan public à 0 € avec -1 partout serait
      // une régression catastrophique (free illimité).
      await seeder.onApplicationBootstrap();

      for (const call of upsert.mock.calls) {
        const p = call[0] as SeededPlan;
        const allUnlimited =
          p.quotaLlmTokens === -1 &&
          p.quotaEmbeddingsTokens === -1 &&
          p.quotaToolRuns === -1 &&
          p.quotaStorageGb === -1;
        if (p.isPublic && p.priceEurMonthMicro === 0) {
          expect(allUnlimited).toBe(false);
        }
      }
    });
  });
});
