import { describe, expect, it, vi } from 'vitest';
import { currentCalendarMonth, QuotaService } from './quota.service';
import type { PlanRow, PlansRepository } from './plans.repository';
import type {
  SubscriptionRow,
  SubscriptionsRepository,
} from './subscriptions.repository';
import type { UsageEventsRepository } from './usage-events.repository';

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
}): { svc: QuotaService; usageSpy: ReturnType<typeof vi.fn> } {
  const usageSpy = vi.fn().mockResolvedValue(opts.used ?? 0);
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
  return {
    svc: new QuotaService(
      plans as PlansRepository,
      subs as SubscriptionsRepository,
      usage as UsageEventsRepository,
    ),
    usageSpy,
  };
}

describe('QuotaService', () => {
  it('utilise la subscription active si elle existe', async () => {
    const plan = makePlan({ quotaLlmTokens: 1000 });
    const sub = makeSub({ planId: plan.id });
    const { svc } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 200,
    });

    const status = await svc.check('ws-1', 'llm_tokens');
    expect(status.allowed).toBe(true);
    expect(status.limit).toBe(1000);
    expect(status.used).toBe(200);
    expect(status.remaining).toBe(800);
    expect(status.planSlug).toBe('test');
    expect(status.periodStart).toEqual(sub.currentPeriodStart);
    expect(status.periodEnd).toEqual(sub.currentPeriodEnd);
  });

  it('retombe sur le plan free + mois calendaire quand aucune subscription', async () => {
    const free = makeFreePlan();
    const { svc, usageSpy } = makeService({
      plansBySlug: { free },
      activeSub: null,
      used: 50,
    });

    const status = await svc.check('ws-unknown', 'llm_tokens');
    expect(status.planSlug).toBe('free');
    expect(status.limit).toBe(200);
    expect(status.used).toBe(50);
    expect(status.remaining).toBe(150);

    const callArgs = usageSpy.mock.calls[0][0];
    const { start, end } = currentCalendarMonth(new Date());
    expect(callArgs.periodStart).toEqual(start);
    expect(callArgs.periodEnd).toEqual(end);
  });

  it('renvoie remaining=null et n’interroge pas l’usage pour limit=null (non-mesuré)', async () => {
    const plan = makePlan({ quotaEmbeddingsTokens: null });
    const sub = makeSub({ planId: plan.id });
    const { svc, usageSpy } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
    });

    const status = await svc.check('ws-1', 'embeddings_tokens');
    expect(status.allowed).toBe(true);
    expect(status.limit).toBeNull();
    expect(status.used).toBe(0);
    expect(status.remaining).toBeNull();
    expect(usageSpy).not.toHaveBeenCalled();
  });

  it('renvoie remaining=null et allowed=true pour illimité (-1), mais compte used', async () => {
    const plan = makePlan({ quotaToolRuns: -1 });
    const sub = makeSub({ planId: plan.id });
    const { svc, usageSpy } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 9_999,
    });

    const status = await svc.check('ws-1', 'tool_runs');
    expect(status.allowed).toBe(true);
    expect(status.limit).toBe(-1);
    expect(status.used).toBe(9_999);
    expect(status.remaining).toBeNull();
    expect(usageSpy).toHaveBeenCalledOnce();
  });

  it('bloque (allowed=false) quand used >= limit', async () => {
    const plan = makePlan({ quotaLlmTokens: 100 });
    const sub = makeSub({ planId: plan.id });
    const { svc } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 100,
    });

    const status = await svc.check('ws-1', 'llm_tokens');
    expect(status.allowed).toBe(false);
    expect(status.remaining).toBe(0);
  });

  it('considère limit=0 comme bloqué dès le premier appel', async () => {
    const plan = makePlan({ quotaStorageGb: 0 });
    const sub = makeSub({ planId: plan.id });
    const { svc } = makeService({
      plansById: { [plan.id]: plan },
      activeSub: sub,
      used: 0,
    });

    const status = await svc.check('ws-1', 'storage_gb_day');
    expect(status.allowed).toBe(false);
    expect(status.limit).toBe(0);
    expect(status.remaining).toBe(0);
  });

  it('échoue explicitement si le plan free est manquant en base', async () => {
    const { svc } = makeService({ activeSub: null });
    await expect(svc.check('ws-1', 'llm_tokens')).rejects.toThrow(/free/i);
  });
});

describe('currentCalendarMonth', () => {
  it('borne UTC : début du mois inclus, début du mois suivant exclus', () => {
    const at = new Date('2026-05-25T13:42:00Z');
    const { start, end } = currentCalendarMonth(at);
    expect(start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('roule sur l’année en décembre', () => {
    const at = new Date('2026-12-31T23:59:59Z');
    const { start, end } = currentCalendarMonth(at);
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
