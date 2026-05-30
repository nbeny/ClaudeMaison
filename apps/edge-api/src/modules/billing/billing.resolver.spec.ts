import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import type { AccessTokenClaims } from '../auth/jwt.service';
import { BillingResolver } from './billing.resolver';
import { USAGE_KINDS } from './kinds';
import type { PlanRow, PlansRepository } from './plans.repository';
import type {
  EffectiveSubscription,
  QuotaService,
  QuotaStatus,
} from './quota.service';

// BillingResolver est la surface GraphQL pour le catalogue des plans
// (public, landing) et le résumé billing d'une workspace (privé, JWT).
// Les invariants critiques :
//
//   - `plans` reste public — aucun appel à db ni à un guard. Si un
//     refactor ajoute @UseGuards par mégarde, la landing casse côté
//     non-loggés.
//
//   - `workspaceBilling` DOIT vérifier l'appartenance via assertMember
//     AVANT tout accès aux quotas / subscription. Sans ça, n'importe
//     quel user loggé peut lire la conso d'une autre workspace en
//     devinant son ID (UUID v7 = ordonné, donc partiellement devinable).
//
//   - assertMember utilise claims.sub (extrait du JWT) — jamais d'arg
//     client. Sinon : usurpation triviale (un attaquant passe son
//     userId aux yeux du serveur, ou pire celui d'un admin).
//
//   - L'ordre compte : assertMember d'abord, quota.* ensuite. Sinon
//     un attaquant pourrait inférer l'existence d'une workspace via
//     side-effects (latence d'erreur quota.check) avant de se faire
//     refuser.
//
//   - Non-membre → ForbiddenException, jamais empty-but-truthy
//     (ex: BillingSummary avec quotas: []), parce qu'un client qui voit
//     un 200 supposerait que la workspace n'existe juste pas
//     d'abonnement actif.

const CLAIMS: AccessTokenClaims = { sub: 'u-alice', sid: 's-1' };

function makePlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 'plan-free',
    slug: 'free',
    name: 'Free',
    description: null,
    quotaLlmTokens: 10000,
    quotaEmbeddingsTokens: null,
    quotaToolRuns: null,
    quotaStorageGb: null,
    priceEurMonthMicro: 0,
    isPublic: true,
    ...overrides,
  };
}

function makeEff(overrides: Partial<EffectiveSubscription> = {}): EffectiveSubscription {
  return {
    plan: makePlan(),
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-06-01T00:00:00Z'),
    subscription: null,
    ...overrides,
  };
}

function makeQuotaStatus(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    allowed: true,
    limit: 10000,
    used: 0,
    remaining: 10000,
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-06-01T00:00:00Z'),
    planSlug: 'free',
    ...overrides,
  };
}

interface Mocks {
  plansRepo: PlansRepository;
  quota: QuotaService;
  db: DatabaseService;
  sqlMock: ReturnType<typeof vi.fn>;
}

function makeMocks(opts: { isMember: boolean } = { isMember: true }): Mocks {
  // db.sql est un tagged template ; on le mocke comme une fonction qui
  // retourne directement la ligne d'EXISTS(SELECT 1 ...). Vrai/faux selon
  // le setup.
  const sqlMock = vi.fn().mockResolvedValue([{ exists: opts.isMember }]);
  return {
    plansRepo: {
      listPublic: vi.fn().mockResolvedValue([]),
    } as unknown as PlansRepository,
    quota: {
      resolveSubscription: vi.fn().mockResolvedValue(makeEff()),
      check: vi.fn().mockResolvedValue(makeQuotaStatus()),
    } as unknown as QuotaService,
    db: { sql: sqlMock as never } as unknown as DatabaseService,
    sqlMock,
  };
}

describe('BillingResolver.plans (catalogue public)', () => {
  it('retourne les plans publics sans toucher au DB direct ni au quota', async () => {
    const m = makeMocks();
    vi.mocked(m.plansRepo.listPublic).mockResolvedValue([
      makePlan({ id: 'p-free', slug: 'free' }),
      makePlan({ id: 'p-pro', slug: 'pro' }),
    ]);
    const resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    const out = await resolver.plans();
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.slug)).toEqual(['free', 'pro']);
    // Pas d'auth → pas de SQL direct (assertMember), pas de quota.
    expect(m.sqlMock).not.toHaveBeenCalled();
    expect(m.quota.resolveSubscription).not.toHaveBeenCalled();
  });

  it('retourne tableau vide si aucun plan public (pas d\'erreur)', async () => {
    const m = makeMocks();
    vi.mocked(m.plansRepo.listPublic).mockResolvedValue([]);
    const resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    await expect(resolver.plans()).resolves.toEqual([]);
  });
});

describe('BillingResolver.workspaceBilling — ACL workspace-membership', () => {
  let m: Mocks;
  let resolver: BillingResolver;

  beforeEach(() => {
    m = makeMocks({ isMember: true });
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
  });

  it('vérifie l\'appartenance via le SQL EXISTS avec (workspaceId, claims.sub)', async () => {
    await resolver.workspaceBilling(CLAIMS, 'w-1');
    // Le premier appel SQL doit être l'EXISTS check. L'implémentation
    // utilise un tagged template, donc on inspecte les valeurs interpolées
    // (indices 1+ du call, l'indice 0 est le TemplateStringsArray).
    expect(m.sqlMock).toHaveBeenCalled();
    const firstCall = m.sqlMock.mock.calls[0]!;
    const interpolated = firstCall.slice(1);
    expect(interpolated).toEqual(['w-1', 'u-alice']);
  });

  it('rejette ForbiddenException si user non-membre (pas de fallback silencieux)', async () => {
    m = makeMocks({ isMember: false });
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    await expect(resolver.workspaceBilling(CLAIMS, 'w-2')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rejette ForbiddenException si EXISTS retourne aucune ligne (DB dégénérée)', async () => {
    // Cas tordu : si une race ou une erreur côté DB renvoie [] au lieu
    // de [{exists:false}], on doit *fail-closed* (pas crash, pas
    // accepter par défaut).
    m = makeMocks();
    m.sqlMock.mockResolvedValueOnce([]);
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    await expect(resolver.workspaceBilling(CLAIMS, 'w-3')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('N\'APPELLE PAS quota.* si le user n\'est pas membre (ordre = check d\'abord)', async () => {
    // CRITIQUE : si l'ordre était inversé (quota d'abord), un attaquant
    // pourrait inférer l'existence d'une workspace ou l'état d'usage
    // par timing/erreurs avant de toucher le mur ACL.
    m = makeMocks({ isMember: false });
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    await expect(resolver.workspaceBilling(CLAIMS, 'w-x')).rejects.toThrow();
    expect(m.quota.resolveSubscription).not.toHaveBeenCalled();
    expect(m.quota.check).not.toHaveBeenCalled();
  });

  it('N\'INCLUT PAS le workspaceId d\'arg dans aucune donnée si non-membre', async () => {
    // Anti-fuite par message d'erreur : on s'assure que l'exception ne
    // contient pas le workspaceId échoué (sinon `ForbiddenException`
    // serait un oracle d'existence trivial).
    m = makeMocks({ isMember: false });
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
    try {
      await resolver.workspaceBilling(CLAIMS, 'w-secret');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('w-secret');
    }
  });
});

describe('BillingResolver.workspaceBilling — happy path (membre)', () => {
  let m: Mocks;
  let resolver: BillingResolver;

  beforeEach(() => {
    m = makeMocks({ isMember: true });
    resolver = new BillingResolver(m.plansRepo, m.quota, m.db);
  });

  it('résout la subscription effective pour la workspace demandée', async () => {
    await resolver.workspaceBilling(CLAIMS, 'w-7');
    expect(m.quota.resolveSubscription).toHaveBeenCalledWith('w-7');
  });

  it('produit une entrée quota par USAGE_KIND (dans le même ordre)', async () => {
    const summary = await resolver.workspaceBilling(CLAIMS, 'w-1');
    expect(summary.quotas).toHaveLength(USAGE_KINDS.length);
    expect(summary.quotas.map((q) => q.kind)).toEqual([...USAGE_KINDS]);
    // Chaque kind a déclenché un appel quota.check(workspaceId, kind).
    for (const kind of USAGE_KINDS) {
      expect(m.quota.check).toHaveBeenCalledWith('w-1', kind);
    }
  });

  it('echoes verbatim workspaceId dans la réponse (pas substitué)', async () => {
    // Anti-confusion : si on remplaçait par eff.subscription.workspaceId
    // ou par un dérivé, un client qui passe `w-1` mais reçoit `w-2`
    // serait dans un état indéterminé.
    const summary = await resolver.workspaceBilling(CLAIMS, 'w-verbatim');
    expect(summary.workspaceId).toBe('w-verbatim');
  });

  it('copie les champs limit/used/remaining/periodes/planSlug du QuotaStatus', async () => {
    vi.mocked(m.quota.check).mockResolvedValue(
      makeQuotaStatus({
        allowed: false,
        limit: 100,
        used: 100,
        remaining: 0,
        planSlug: 'pro',
      }),
    );
    const summary = await resolver.workspaceBilling(CLAIMS, 'w-1');
    const q0 = summary.quotas[0]!;
    expect(q0.allowed).toBe(false);
    expect(q0.limit).toBe(100);
    expect(q0.used).toBe(100);
    expect(q0.remaining).toBe(0);
    expect(q0.planSlug).toBe('pro');
  });

  it('expose les périodes de l\'EffectiveSubscription au top-level du summary', async () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-06-01T00:00:00Z');
    vi.mocked(m.quota.resolveSubscription).mockResolvedValue(
      makeEff({ periodStart: start, periodEnd: end }),
    );
    const summary = await resolver.workspaceBilling(CLAIMS, 'w-1');
    expect(summary.periodStart).toEqual(start);
    expect(summary.periodEnd).toEqual(end);
  });

  it('le plan retourné reflète celui de l\'EffectiveSubscription, pas le free par défaut', async () => {
    const proPlan = makePlan({ id: 'p-pro', slug: 'pro', name: 'Pro' });
    vi.mocked(m.quota.resolveSubscription).mockResolvedValue(
      makeEff({ plan: proPlan }),
    );
    const summary = await resolver.workspaceBilling(CLAIMS, 'w-1');
    expect(summary.plan.slug).toBe('pro');
    expect(summary.plan.name).toBe('Pro');
  });
});
