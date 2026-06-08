import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../../observability/metrics.service';
import type { PlanRow, PlansRepository } from './plans.repository';
import { QuotaService } from './quota.service';
import type {
  SubscriptionRow,
  SubscriptionsRepository,
} from './subscriptions.repository';
import type { UsageEventsRepository } from './usage-events.repository';

// Caractérisation QuotaService — invariants subtils NON couverts par
// quota.service.spec.ts.
//
//   - **Subscription orpheline → fallback free + logger.error** : la FK
//     billing.subscriptions.plan_id → billing.plans.id garantit l'intégrité,
//     mais si un opérateur fait `DELETE FROM billing.plans WHERE id=...`
//     sans CASCADE, on se retrouve avec une sub.planId pointant dans le
//     vide. Le code log un error et retombe au plan free. C'est un
//     fail-soft volontaire — on ne veut PAS bloquer la workspace sur une
//     incohérence DB qui n'est pas de sa faute.
//
//   - **Métrique recordQuotaCheck émise sur les 3 branches** : non-mesuré
//     (limit=null), illimité (-1), plafond. Si on omettait l'émission sur
//     une branche, les dashboards Grafana sous-estimeraient le trafic
//     quota silencieusement.
//
//   - **resolveSubscription expose subscription=null pour le fallback free**
//     vs la subscription concrète sinon. Les callers (futur PSP / facturation)
//     ont besoin de distinguer "free implicite Jour-1" de "sub free explicite".
//
//   - **Le champ subscription de EffectiveSubscription est la même référence
//     que celle retournée par le repo** : pas de clone, pas de transform.
//     Caller pourra s'appuyer sur l'identité (===) si besoin.

function makePlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 'plan-id',
    slug: 'test',
    name: 'Test',
    description: null,
    quotaLlmTokens: 1000,
    quotaEmbeddingsTokens: null,
    quotaToolRuns: -1,
    quotaStorageGb: 0,
    priceEurMonthMicro: 0,
    isPublic: true,
    ...overrides,
  };
}

function makeFreePlan(): PlanRow {
  return makePlan({ id: 'free-id', slug: 'free', name: 'Free', quotaLlmTokens: 200 });
}

function makeSub(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub-id',
    workspaceId: 'ws-1',
    planId: 'plan-id',
    status: 'active',
    currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
    cancelledAt: null,
    ...overrides,
  };
}

function makeService(opts: {
  plansBySlug?: Record<string, PlanRow>;
  plansById?: Record<string, PlanRow>;
  activeSub?: SubscriptionRow | null;
  used?: number;
}): {
  svc: QuotaService;
  usageSpy: ReturnType<typeof vi.fn>;
  metricsSpy: ReturnType<typeof vi.fn>;
} {
  const usageSpy = vi.fn().mockResolvedValue(opts.used ?? 0);
  const metricsSpy = vi.fn();
  const plans: Partial<PlansRepository> = {
    findBySlug: vi.fn(async (slug: string) => opts.plansBySlug?.[slug] ?? null),
    findById: vi.fn(async (id: string) => opts.plansById?.[id] ?? null),
  };
  const subs: Partial<SubscriptionsRepository> = {
    findActiveByWorkspace: vi.fn(async () => opts.activeSub ?? null),
  };
  const usage: Partial<UsageEventsRepository> = {
    sumQuantity: usageSpy,
  };
  const metrics: Partial<MetricsService> = {
    recordQuotaCheck: metricsSpy,
  };
  return {
    svc: new QuotaService(
      plans as PlansRepository,
      subs as SubscriptionsRepository,
      usage as UsageEventsRepository,
      metrics as MetricsService,
    ),
    usageSpy,
    metricsSpy,
  };
}

describe('QuotaService — subscription orpheline (sub.planId introuvable)', () => {
  it('retombe sur le plan free et log un error sans crasher', async () => {
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const free = makeFreePlan();
    const sub = makeSub({ id: 'sub-orphan', planId: 'plan-deleted' });
    const { svc } = makeService({
      plansBySlug: { free },
      plansById: {}, // findById('plan-deleted') → null
      activeSub: sub,
      used: 0,
    });

    const status = await svc.check('ws-1', 'llm_tokens');

    expect(status.planSlug).toBe('free');
    expect(status.limit).toBe(200);
    expect(errorSpy).toHaveBeenCalledOnce();
    const msg = errorSpy.mock.calls[0]?.[0];
    expect(msg).toMatch(/sub-orphan/);
    expect(msg).toMatch(/plan-deleted/);

    errorSpy.mockRestore();
  });

  it('utilise le mois calendaire courant comme période (pas la période de la sub orpheline)', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const free = makeFreePlan();
    const sub = makeSub({
      planId: 'plan-deleted',
      currentPeriodStart: new Date('2020-01-01T00:00:00Z'),
      currentPeriodEnd: new Date('2020-02-01T00:00:00Z'),
    });
    const { svc, usageSpy } = makeService({
      plansBySlug: { free },
      plansById: {},
      activeSub: sub,
      used: 10,
    });

    const status = await svc.check('ws-1', 'llm_tokens');

    // Les périodes de la sub orpheline (2020) DOIVENT être écartées au
    // profit du mois calendaire courant — sinon on facturerait un usage
    // sur une fenêtre historique close.
    expect(status.periodStart.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    expect(status.periodEnd.getTime()).toBeGreaterThan(status.periodStart.getTime());

    const callPeriod = usageSpy.mock.calls[0][0];
    expect(callPeriod.periodStart).toEqual(status.periodStart);
    expect(callPeriod.periodEnd).toEqual(status.periodEnd);
  });
});

describe('QuotaService — métrique recordQuotaCheck sur toutes les branches', () => {
  it('émet la métrique pour la branche non-mesurée (limit=null)', async () => {
    const plan = makePlan({ quotaEmbeddingsTokens: null });
    const sub = makeSub({ planId: plan.id });
    const { svc, metricsSpy } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
    });

    await svc.check('ws-1', 'embeddings_tokens');
    expect(metricsSpy).toHaveBeenCalledWith('embeddings_tokens', true);
  });

  it('émet la métrique pour la branche illimité (limit=-1)', async () => {
    const plan = makePlan({ quotaToolRuns: -1 });
    const sub = makeSub({ planId: plan.id });
    const { svc, metricsSpy } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 10_000,
    });

    await svc.check('ws-1', 'tool_runs');
    expect(metricsSpy).toHaveBeenCalledWith('tool_runs', true);
  });

  it('émet la métrique pour la branche plafond — allowed=true quand used<limit', async () => {
    const plan = makePlan({ quotaLlmTokens: 100 });
    const sub = makeSub({ planId: plan.id });
    const { svc, metricsSpy } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 50,
    });

    await svc.check('ws-1', 'llm_tokens');
    expect(metricsSpy).toHaveBeenCalledWith('llm_tokens', true);
  });
});

describe('QuotaService.resolveSubscription — contrat de retour', () => {
  it('renvoie subscription=null pour le fallback free implicite', async () => {
    const free = makeFreePlan();
    const { svc } = makeService({
      plansBySlug: { free },
      activeSub: null,
    });

    const eff = await svc.resolveSubscription('ws-orphan');
    expect(eff.subscription).toBeNull();
    expect(eff.plan.slug).toBe('free');
  });

  it('renvoie la subscription exacte (===, pas un clone) quand active', async () => {
    const plan = makePlan();
    const sub = makeSub({ planId: plan.id });
    const { svc } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
    });

    const eff = await svc.resolveSubscription('ws-1');
    expect(eff.subscription).toBe(sub); // identité de référence
    expect(eff.plan).toBe(plan);
    expect(eff.periodStart).toBe(sub.currentPeriodStart);
    expect(eff.periodEnd).toBe(sub.currentPeriodEnd);
  });

  it('renvoie subscription=null aussi quand la sub est orpheline (fallback)', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const free = makeFreePlan();
    const sub = makeSub({ planId: 'plan-deleted' });
    const { svc } = makeService({
      plansBySlug: { free },
      plansById: {},
      activeSub: sub,
    });

    const eff = await svc.resolveSubscription('ws-1');
    expect(eff.subscription).toBeNull(); // fallback efface la sub orpheline
    expect(eff.plan.slug).toBe('free');
  });
});
