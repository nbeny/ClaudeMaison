import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { BillingGrpcAuthGuard } from './billing-grpc-auth.guard';
import { BillingService, type RawUsageEvent } from './billing.service';

// Représentation `protobufjs`-style des Timestamp google. Le loader transforme
// déjà ces messages en objets `{ seconds, nanos }` (longs convertis en string
// par défaut, voir options du loader dans main.ts).
interface PbTimestamp {
  seconds?: string | number;
  nanos?: number;
}

interface PbUsageEvent {
  idempotencyKey?: string;
  workspaceId?: string;
  userId?: string;
  kind?: string;
  quantity?: number;
  unit?: string;
  costEurMicro?: string | number;
  occurredAt?: PbTimestamp;
  metadata?: Record<string, string>;
}

interface RecordUsageRequest {
  events?: PbUsageEvent[];
}

interface CheckQuotaRequest {
  workspaceId?: string;
  kind?: string;
}

@Controller()
@UseGuards(BillingGrpcAuthGuard)
export class BillingGrpcController {
  constructor(private readonly billing: BillingService) {}

  @GrpcMethod('Billing', 'RecordUsage')
  async recordUsage(
    req: RecordUsageRequest,
  ): Promise<{ accepted: number; duplicates: number }> {
    const events = (req.events ?? []).map(toRawEvent);
    return this.billing.recordUsage(events);
  }

  @GrpcMethod('Billing', 'CheckQuota')
  async checkQuota(req: CheckQuotaRequest): Promise<{
    allowed: boolean;
    limit?: number;
    used: number;
    remaining?: number;
    periodStart: { seconds: number; nanos: number };
    periodEnd: { seconds: number; nanos: number };
    planSlug: string;
  }> {
    const status = await this.billing.checkQuota(req.workspaceId ?? '', req.kind ?? '');
    return {
      allowed: status.allowed,
      // proto3 optional → undefined si non-mesuré, sinon nombre brut (-1 ou >=0).
      limit: status.limit === null ? undefined : status.limit,
      used: status.used,
      remaining: status.remaining === null ? undefined : status.remaining,
      periodStart: toPbTimestamp(status.periodStart),
      periodEnd: toPbTimestamp(status.periodEnd),
      planSlug: status.planSlug,
    };
  }
}

function toRawEvent(pb: PbUsageEvent): RawUsageEvent {
  return {
    idempotencyKey: pb.idempotencyKey ?? '',
    workspaceId: pb.workspaceId ?? '',
    userId: pb.userId && pb.userId.length > 0 ? pb.userId : null,
    kind: pb.kind ?? '',
    quantity: Number(pb.quantity ?? 0),
    unit: pb.unit ?? '',
    costEurMicro: Number(pb.costEurMicro ?? 0),
    occurredAt: fromPbTimestamp(pb.occurredAt) ?? new Date(),
    metadata: pb.metadata && Object.keys(pb.metadata).length > 0 ? pb.metadata : null,
  };
}

function fromPbTimestamp(ts: PbTimestamp | undefined): Date | null {
  if (!ts) return null;
  const seconds = Number(ts.seconds ?? 0);
  const nanos = ts.nanos ?? 0;
  if (seconds === 0 && nanos === 0) return null;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000));
}

function toPbTimestamp(d: Date): { seconds: number; nanos: number } {
  const ms = d.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanos: (ms % 1000) * 1_000_000,
  };
}
