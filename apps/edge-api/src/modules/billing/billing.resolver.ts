import { ForbiddenException, UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { DatabaseService } from '../../database/database.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AccessTokenClaims } from '../auth/jwt.service';
import { USAGE_KINDS, type UsageKind } from './kinds';
import { BillingSummary } from './models/billing-summary.model';
import { Plan } from './models/plan.model';
import { QuotaStatusModel } from './models/quota-status.model';
import { PlansRepository } from './plans.repository';
import { QuotaService } from './quota.service';

@Resolver()
export class BillingResolver {
  constructor(
    private readonly plansRepo: PlansRepository,
    private readonly quota: QuotaService,
    private readonly db: DatabaseService,
  ) {}

  // Catalogue public, pas d'auth requise (utilisé sur la landing).
  @Query(() => [Plan])
  async plans(): Promise<Plan[]> {
    const rows = await this.plansRepo.listPublic();
    return rows.map((r) => Object.assign(new Plan(), r));
  }

  @Query(() => BillingSummary)
  @UseGuards(JwtAuthGuard)
  async workspaceBilling(
    @CurrentUser() claims: AccessTokenClaims,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
  ): Promise<BillingSummary> {
    await this.assertMember(workspaceId, claims.sub);

    const eff = await this.quota.resolveSubscription(workspaceId);
    const quotas: QuotaStatusModel[] = [];
    for (const kind of USAGE_KINDS) {
      const status = await this.quota.check(workspaceId, kind as UsageKind);
      quotas.push(
        Object.assign(new QuotaStatusModel(), {
          kind,
          allowed: status.allowed,
          limit: status.limit,
          used: status.used,
          remaining: status.remaining,
          periodStart: status.periodStart,
          periodEnd: status.periodEnd,
          planSlug: status.planSlug,
        }),
      );
    }

    return Object.assign(new BillingSummary(), {
      workspaceId,
      plan: Object.assign(new Plan(), eff.plan),
      periodStart: eff.periodStart,
      periodEnd: eff.periodEnd,
      quotas,
    });
  }

  // Garde minimale : appartenance à la workspace (n'importe quel rôle).
  // Le RBAC fin (admin/owner-only pour upgrade) viendra avec le flow billing
  // côté GraphQL, hors scope étape 4.
  private async assertMember(workspaceId: string, userId: string): Promise<void> {
    const rows = await this.db.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM auth.workspace_members
        WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      ) AS exists
    `;
    if (!rows[0]?.exists) {
      throw new ForbiddenException('Vous n’êtes pas membre de cette workspace.');
    }
  }
}
