import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingGrpcController } from './billing-grpc.controller';
import type { BillingService, RawUsageEvent } from './billing.service';
import type { QuotaStatus } from './quota.service';

// BillingGrpcController est l'adapter gRPC : il convertit les messages
// protobuf (`protobufjs`-style : `{seconds:string|number, nanos:number}`)
// vers les types domaine de BillingService, et reformate la réponse de
// CheckQuota en respectant les `proto3 optional` (null → undefined).
//
// Invariants critiques verrouillés ici :
//
//   - userId protobuf vide ('') → null en domaine. Sinon on insère des
//     usage_events avec user_id='' (FK foireuse, oracle d'existence).
//
//   - metadata protobuf vide ({}) → null. Sinon : insertions inutiles
//     d'objets vides qui polluent le storage et compliquent les requêtes
//     "metadata is null".
//
//   - quantity / costEurMicro : `Number(undefined)` = NaN, donc la
//     coercion doit utiliser `?? 0`. Sinon BillingService voit NaN,
//     refuse, et le caller reçoit BadRequest au lieu d'un succès silencieux.
//
//   - Timestamp.seconds peut arriver en string (protobufjs long-as-string).
//     On vérifie qu'on lit bien via Number(seconds), pas en string brute
//     (Date(string) explose en NaN).
//
//   - Timestamp sentinel (seconds=0, nanos=0) → null, pas Date(0) =
//     1970-01-01. Critique pour `occurredAt` : si on stockait Date(0),
//     toutes les conso "non-datées" seraient comptées sur janvier 1970
//     et exclues des périodes courantes (= bypass de quota).
//
//   - CheckQuota response : status.limit null → undefined (proto3 optional).
//     Si on envoyait `null`, protobufjs/grpc-js sérialiserait `0` selon
//     le runtime, ce qui ferait "quota = 0" côté client.
//
//   - recordUsage avec events absents / vide : pas de crash, retour 0/0.

const POINT_IN_TIME = new Date('2026-05-30T12:34:56.789Z');

function makeStatus(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    allowed: true,
    limit: 10000,
    used: 250,
    remaining: 9750,
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-01T00:00:00.000Z'),
    planSlug: 'free',
    ...overrides,
  };
}

function makeBilling(): BillingService {
  return {
    recordUsage: vi.fn().mockResolvedValue({ accepted: 0, duplicates: 0 }),
    checkQuota: vi.fn().mockResolvedValue(makeStatus()),
  } as unknown as BillingService;
}

describe('BillingGrpcController.recordUsage — conversions PB→domain', () => {
  let billing: BillingService;
  let ctrl: BillingGrpcController;

  beforeEach(() => {
    billing = makeBilling();
    ctrl = new BillingGrpcController(billing);
  });

  it('retourne {accepted:0, duplicates:0} sans appeler billing si events est undefined', async () => {
    const res = await ctrl.recordUsage({});
    expect(res).toEqual({ accepted: 0, duplicates: 0 });
    // BillingService.recordUsage([]) court-circuite à 0/0 — on relaie tel quel.
    expect(billing.recordUsage).toHaveBeenCalledWith([]);
  });

  it('retourne {accepted:0, duplicates:0} si events est un tableau vide', async () => {
    const res = await ctrl.recordUsage({ events: [] });
    expect(res).toEqual({ accepted: 0, duplicates: 0 });
    expect(billing.recordUsage).toHaveBeenCalledWith([]);
  });

  it('mappe userId="" → null (anti-empty-string en colonne user_id)', async () => {
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          userId: '',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: 1700000000, nanos: 0 },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.userId).toBeNull();
  });

  it('mappe userId présent → tel quel (string non vide)', async () => {
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          userId: 'u-alice',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: 1700000000, nanos: 0 },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.userId).toBe('u-alice');
  });

  it('mappe metadata={} → null (anti-objet-vide en JSONB)', async () => {
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: 1700000000, nanos: 0 },
          metadata: {},
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.metadata).toBeNull();
  });

  it('mappe metadata={k:v} → kept tel quel', async () => {
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: 1700000000, nanos: 0 },
          metadata: { model: 'mistral-7b' },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.metadata).toEqual({ model: 'mistral-7b' });
  });

  it('coerce quantity undefined → 0 (pas NaN qui ferait planter BillingService)', async () => {
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          // quantity volontairement absent
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: 1700000000, nanos: 0 },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.quantity).toBe(0);
    expect(Number.isNaN(mapped[0]!.quantity)).toBe(false);
  });

  it('coerce costEurMicro="50" (string protobufjs) → 50 (number)', async () => {
    // protobufjs sérialise les int64 en string par défaut. On doit
    // re-coercer avant de passer en domaine.
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: '50',
          occurredAt: { seconds: 1700000000, nanos: 0 },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(mapped[0]!.costEurMicro).toBe(50);
    expect(typeof mapped[0]!.costEurMicro).toBe('number');
  });

  it('Timestamp seconds="1700000000" (string) parsé via Number → Date OK', async () => {
    // Sans Number(seconds), Date(string * 1000) = NaN → "Invalid Date"
    // et toute la chaîne usage_events stocke un timestamp invalide.
    await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          quantity: 100,
          unit: 'tokens',
          costEurMicro: 50,
          occurredAt: { seconds: '1700000000', nanos: 0 },
        },
      ],
    });
    const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
    expect(Number.isNaN(mapped[0]!.occurredAt.getTime())).toBe(false);
    expect(mapped[0]!.occurredAt.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('Timestamp absent → occurredAt = now (pas crash, pas Date(0))', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(POINT_IN_TIME);
    try {
      await ctrl.recordUsage({
        events: [
          {
            idempotencyKey: 'k1',
            workspaceId: 'w1',
            kind: 'llm_tokens',
            quantity: 100,
            unit: 'tokens',
            costEurMicro: 50,
            // occurredAt absent
          },
        ],
      });
      const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
      expect(mapped[0]!.occurredAt.toISOString()).toBe(POINT_IN_TIME.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('Timestamp sentinel (seconds=0, nanos=0) → traité comme absent → now', async () => {
    // CRITIQUE : Date(0) = 1970-01-01. Si on l'utilisait, toutes les
    // conso "non-datées" seraient mises en 1970 et exclues des
    // périodes courantes (= bypass de quota). On replie sur `new Date()`.
    vi.useFakeTimers();
    vi.setSystemTime(POINT_IN_TIME);
    try {
      await ctrl.recordUsage({
        events: [
          {
            idempotencyKey: 'k1',
            workspaceId: 'w1',
            kind: 'llm_tokens',
            quantity: 100,
            unit: 'tokens',
            costEurMicro: 50,
            occurredAt: { seconds: 0, nanos: 0 },
          },
        ],
      });
      const mapped = vi.mocked(billing.recordUsage).mock.calls[0]![0] as RawUsageEvent[];
      expect(mapped[0]!.occurredAt.toISOString()).toBe(POINT_IN_TIME.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('relaie le résultat {accepted, duplicates} retourné par BillingService', async () => {
    vi.mocked(billing.recordUsage).mockResolvedValue({ accepted: 3, duplicates: 1 });
    const res = await ctrl.recordUsage({
      events: [
        {
          idempotencyKey: 'k1',
          workspaceId: 'w1',
          kind: 'llm_tokens',
          quantity: 1,
          unit: 'tokens',
          costEurMicro: 0,
          occurredAt: { seconds: 1700000000, nanos: 0 },
        },
      ],
    });
    expect(res).toEqual({ accepted: 3, duplicates: 1 });
  });
});

describe('BillingGrpcController.checkQuota — null↔undefined pour proto3 optional', () => {
  let billing: BillingService;
  let ctrl: BillingGrpcController;

  beforeEach(() => {
    billing = makeBilling();
    ctrl = new BillingGrpcController(billing);
  });

  it('passe workspaceId et kind verbatim à billing.checkQuota', async () => {
    await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(billing.checkQuota).toHaveBeenCalledWith('w-1', 'llm_tokens');
  });

  it('mappe workspaceId undefined → "" (BillingService valide ensuite)', async () => {
    await ctrl.checkQuota({});
    expect(billing.checkQuota).toHaveBeenCalledWith('', '');
  });

  it('status.limit null → response.limit undefined (proto3 optional)', async () => {
    // CRITIQUE : si on envoyait `null`, protobufjs/grpc-js peut le
    // sérialiser en 0 ("quota = 0 = bloqué") selon la version. On
    // doit traduire null en undefined pour omission complète.
    vi.mocked(billing.checkQuota).mockResolvedValue(
      makeStatus({ limit: null, remaining: null }),
    );
    const res = await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(res.limit).toBeUndefined();
    expect(res.remaining).toBeUndefined();
  });

  it('status.limit -1 → response.limit -1 (illimité explicite, pas undefined)', async () => {
    // -1 ≠ null : -1 est une valeur sentinelle légitime "illimité" qui
    // doit transiter, sinon le client ne peut pas distinguer "non mesuré"
    // de "illimité".
    vi.mocked(billing.checkQuota).mockResolvedValue(
      makeStatus({ limit: -1, remaining: null }),
    );
    const res = await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(res.limit).toBe(-1);
  });

  it('copie les autres champs (allowed, used, planSlug) verbatim', async () => {
    vi.mocked(billing.checkQuota).mockResolvedValue(
      makeStatus({ allowed: false, used: 9999, planSlug: 'pro' }),
    );
    const res = await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(res.allowed).toBe(false);
    expect(res.used).toBe(9999);
    expect(res.planSlug).toBe('pro');
  });

  it('périodes converties en {seconds, nanos} (date → pb timestamp)', async () => {
    // 2026-05-01T00:00:00.000Z = epoch 1777939200, nanos = 0
    // 2026-06-01T00:00:00.000Z = epoch 1780617600, nanos = 0
    const start = new Date('2026-05-01T00:00:00.000Z');
    const end = new Date('2026-06-01T00:00:00.000Z');
    vi.mocked(billing.checkQuota).mockResolvedValue(
      makeStatus({ periodStart: start, periodEnd: end }),
    );
    const res = await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(res.periodStart.seconds).toBe(Math.floor(start.getTime() / 1000));
    expect(res.periodEnd.seconds).toBe(Math.floor(end.getTime() / 1000));
    expect(res.periodStart.nanos).toBe(0);
  });

  it('Timestamp avec millisecondes → seconds + nanos non nuls', async () => {
    // ms = 123 → nanos = 123_000_000 (123 millions de nanos)
    const dateWithMs = new Date('2026-05-30T12:34:56.123Z');
    vi.mocked(billing.checkQuota).mockResolvedValue(
      makeStatus({ periodStart: dateWithMs }),
    );
    const res = await ctrl.checkQuota({ workspaceId: 'w-1', kind: 'llm_tokens' });
    expect(res.periodStart.nanos).toBe(123_000_000);
  });
});
