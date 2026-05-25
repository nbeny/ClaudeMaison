import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { isUsageKind, type UsageKind } from './kinds';
import { QuotaService, type QuotaStatus } from './quota.service';
import {
  UsageEventsRepository,
  type BatchInsertResult,
  type UsageEventInput,
} from './usage-events.repository';

export interface RawUsageEvent {
  idempotencyKey: string;
  workspaceId: string;
  userId?: string | null;
  kind: string;
  quantity: number;
  unit: string;
  costEurMicro: number;
  occurredAt: Date;
  metadata?: Record<string, string> | null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly usage: UsageEventsRepository,
    private readonly quota: QuotaService,
  ) {}

  async recordUsage(events: readonly RawUsageEvent[]): Promise<BatchInsertResult> {
    if (events.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }

    const normalized: UsageEventInput[] = events.map((e) => {
      if (!isUsageKind(e.kind)) {
        throw new BadRequestException(`kind invalide: ${e.kind}`);
      }
      if (!e.idempotencyKey) {
        throw new BadRequestException('idempotency_key manquant.');
      }
      if (!e.workspaceId) {
        throw new BadRequestException('workspace_id manquant.');
      }
      if (Number.isNaN(e.quantity) || e.quantity < 0) {
        throw new BadRequestException(`quantity invalide pour ${e.kind}: ${e.quantity}`);
      }
      return {
        idempotencyKey: e.idempotencyKey,
        workspaceId: e.workspaceId,
        userId: e.userId ?? null,
        kind: e.kind,
        quantity: e.quantity,
        unit: e.unit,
        costEurMicro: e.costEurMicro,
        occurredAt: e.occurredAt,
        metadata: e.metadata ?? null,
      };
    });

    const result = await this.usage.insertBatch(normalized);
    this.logger.debug(
      `recordUsage: ${result.accepted} acceptés, ${result.duplicates} doublons.`,
    );
    return result;
  }

  async checkQuota(workspaceId: string, kind: string): Promise<QuotaStatus> {
    if (!workspaceId) {
      throw new BadRequestException('workspace_id manquant.');
    }
    if (!isUsageKind(kind)) {
      throw new BadRequestException(`kind invalide: ${kind}`);
    }
    return this.quota.check(workspaceId, kind as UsageKind);
  }
}
