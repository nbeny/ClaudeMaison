import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../observability/metrics.service';
import type { UsageKind } from './kinds';
import { planQuotaFor, type PlanRow, PlansRepository } from './plans.repository';
import {
  SubscriptionsRepository,
  type SubscriptionRow,
} from './subscriptions.repository';
import { UsageEventsRepository } from './usage-events.repository';

export interface QuotaStatus {
  allowed: boolean;
  limit: number | null; // null = ressource non-mesurée, -1 = illimité
  used: number;
  remaining: number | null; // null si non-mesurée ou illimitée
  periodStart: Date;
  periodEnd: Date;
  planSlug: string;
}

export interface EffectiveSubscription {
  plan: PlanRow;
  periodStart: Date;
  periodEnd: Date;
  // null si on a retombé sur le plan free par défaut (workspace sans sub)
  subscription: SubscriptionRow | null;
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly plans: PlansRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly usage: UsageEventsRepository,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Résout la subscription effective d'une workspace. Fallback explicite
   * sur le plan `free` avec une période = mois calendaire courant si :
   *   - la workspace n'a pas de subscription active, OU
   *   - la workspace n'existe pas encore (le couplage usage_events→workspace
   *     est faible, on accepte la CheckQuota et le caller décide).
   *
   * Le fallback rend le système utilisable Jour-1 sans flow de création de
   * workspace. Plus tard, le free plan deviendra une subscription explicite
   * créée à la naissance de la workspace.
   */
  async resolveSubscription(workspaceId: string): Promise<EffectiveSubscription> {
    const sub = await this.subscriptions.findActiveByWorkspace(workspaceId);
    if (sub) {
      const plan = await this.plans.findById(sub.planId);
      if (!plan) {
        // Incohérence : la FK garantit que le plan existe, mais on log et on
        // retombe au cas où un opérateur ait fait une suppression manuelle.
        this.logger.error(
          `Subscription ${sub.id} pointe vers un plan ${sub.planId} introuvable — fallback free.`,
        );
        return this.freeFallback();
      }
      return {
        plan,
        periodStart: sub.currentPeriodStart,
        periodEnd: sub.currentPeriodEnd,
        subscription: sub,
      };
    }
    return this.freeFallback();
  }

  async check(workspaceId: string, kind: UsageKind): Promise<QuotaStatus> {
    const status = await this.computeStatus(workspaceId, kind);
    this.metrics.recordQuotaCheck(kind, status.allowed);
    return status;
  }

  private async computeStatus(
    workspaceId: string,
    kind: UsageKind,
  ): Promise<QuotaStatus> {
    const eff = await this.resolveSubscription(workspaceId);
    const limit = planQuotaFor(eff.plan, kind);

    // Cas 1 : ressource non-mesurée pour ce plan. On autorise sans compter.
    if (limit === null) {
      return {
        allowed: true,
        limit: null,
        used: 0,
        remaining: null,
        periodStart: eff.periodStart,
        periodEnd: eff.periodEnd,
        planSlug: eff.plan.slug,
      };
    }

    // Cas 2 : illimité explicite.
    if (limit === -1) {
      const used = await this.usage.sumQuantity({
        workspaceId,
        kind,
        periodStart: eff.periodStart,
        periodEnd: eff.periodEnd,
      });
      return {
        allowed: true,
        limit: -1,
        used,
        remaining: null,
        periodStart: eff.periodStart,
        periodEnd: eff.periodEnd,
        planSlug: eff.plan.slug,
      };
    }

    // Cas 3 : plafond strict (incl. 0 = bloqué).
    const used = await this.usage.sumQuantity({
      workspaceId,
      kind,
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd,
    });
    const remaining = Math.max(0, limit - used);
    return {
      allowed: used < limit,
      limit,
      used,
      remaining,
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd,
      planSlug: eff.plan.slug,
    };
  }

  private async freeFallback(): Promise<EffectiveSubscription> {
    const free = await this.plans.findBySlug('free');
    if (!free) {
      // PlansSeeder garantit la présence du plan free au démarrage. Si on
      // arrive ici, soit le seeder a échoué, soit quelqu'un a fait DELETE
      // FROM billing.plans WHERE slug='free' à la main. Fail-fast.
      throw new Error('Plan "free" introuvable. Le PlansSeeder a-t-il été exécuté ?');
    }
    const { start, end } = currentCalendarMonth(new Date());
    return { plan: free, periodStart: start, periodEnd: end, subscription: null };
  }
}

// Période = mois calendaire UTC contenant `at`. C'est un choix volontairement
// simple Jour-1 : pas de pro-ration ni d'anniversaire personnalisé. Quand on
// branchera un PSP, la subscription portera ses propres dates.
export function currentCalendarMonth(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}
