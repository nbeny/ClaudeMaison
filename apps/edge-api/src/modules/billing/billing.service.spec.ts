import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { MetricsService } from '../../observability/metrics.service';
import { BillingService, type RawUsageEvent } from './billing.service';
import type { QuotaService, QuotaStatus } from './quota.service';
import type {
  BatchInsertResult,
  UsageEventsRepository,
} from './usage-events.repository';

// BillingService est la couche de validation entre :
//   - l'entrée gRPC `recordUsage` (du controller PB)
//   - le repo `UsageEventsRepository.insertBatch` (qui ÉCRIT en DB)
//
// Les invariants critiques sont financiers et de sécurité multi-tenant :
//
//   - ATOMICITÉ DE LA VALIDATION : si UN seul événement du batch est
//     invalide, AUCUN n'est inséré. Sans ça, un attaquant pourrait
//     glisser un événement valide à côté d'un événement invalide
//     (kind=trash, idempotencyKey=) pour parasiter la facturation tout
//     en validant son débit. Le throw doit se produire AVANT le call
//     à insertBatch.
//
//   - QUANTITY ≥ 0 : autoriser un `quantity` négatif créerait du crédit
//     côté quota (consommation négative = quota restauré). Le coût en
//     micro-euros suit en bigint mais la validation `quantity` est la
//     dernière ligne de défense contre la perte de revenu.
//
//   - QUANTITY NaN rejeté : NaN dans une somme PG SUM() retourne NaN
//     pour TOUTES les agrégations du workspace → dashboards de
//     facturation cassés pour ce tenant.
//
//   - IDEMPOTENCY_KEY non vide : la déduplication ON CONFLICT repose
//     dessus. Empty key + retries = double-facturation triviale.
//
//   - WORKSPACE_ID non vide : sans ça, on pourrait écrire des events
//     orphelins qui ne s'attachent à aucun tenant.
//
//   - BadRequestException (PAS Error nu) : Nest sérialise en 400, donc
//     le client gRPC voit `INVALID_ARGUMENT` ; sinon 500 = `INTERNAL`,
//     qui suggère que c'est NOTRE faute et déclenche les retries du
//     client → amplification.
//
//   - NORMALISATION userId/metadata : `undefined` côté gRPC arrive ici
//     comme `undefined`, on doit le stocker `null` en DB (la colonne
//     accepte null mais pas undefined → erreur driver).
//
//   - METRICS appelée APRÈS l'insert, avec le RÉSULTAT de l'insert (pas
//     l'input). Sinon on compte des "accepted" pour des batches que la
//     DB a en réalité dédupliqués → métriques mensongères.
//
//   - PATH VIDE : events=[] retourne `{0,0}` sans toucher DB ni
//     métriques (pas de no-op qui pollue les compteurs).

const NOW = new Date('2026-05-31T12:00:00Z');

function makeEvent(over: Partial<RawUsageEvent> = {}): RawUsageEvent {
  return {
    idempotencyKey: 'idem-1',
    workspaceId: 'w-1',
    userId: 'u-1',
    kind: 'llm_tokens',
    quantity: 100,
    unit: 'tokens',
    costEurMicro: 50,
    occurredAt: NOW,
    metadata: { model: 'mistral-7b' },
    ...over,
  };
}

interface Mocks {
  service: BillingService;
  usage: UsageEventsRepository;
  insertBatch: ReturnType<typeof vi.fn>;
  quota: QuotaService;
  quotaCheck: ReturnType<typeof vi.fn>;
  metrics: MetricsService;
  recordUsageEvents: ReturnType<typeof vi.fn>;
}

function makeMocks(insertResult: BatchInsertResult = { accepted: 1, duplicates: 0 }): Mocks {
  const insertBatch = vi.fn().mockResolvedValue(insertResult);
  const usage = { insertBatch } as unknown as UsageEventsRepository;

  const quotaCheck = vi.fn();
  const quota = { check: quotaCheck } as unknown as QuotaService;

  const recordUsageEvents = vi.fn();
  const metrics = { recordUsageEvents } as unknown as MetricsService;

  const service = new BillingService(usage, quota, metrics);
  return { service, usage, insertBatch, quota, quotaCheck, metrics, recordUsageEvents };
}

describe('BillingService.recordUsage — chemin vide', () => {
  it('events=[] → {accepted:0, duplicates:0} SANS toucher insertBatch ni métriques', async () => {
    // Critique pour les compteurs OTel : un no-op qui appellerait
    // recordUsageEvents(0,0) ferait gonfler les counters avec des
    // labels result=accepted/duplicate sans nouvelle data.
    const { service, insertBatch, recordUsageEvents } = makeMocks();
    const r = await service.recordUsage([]);
    expect(r).toEqual({ accepted: 0, duplicates: 0 });
    expect(insertBatch).not.toHaveBeenCalled();
    expect(recordUsageEvents).not.toHaveBeenCalled();
  });
});

describe('BillingService.recordUsage — validation atomique (rien inséré si UN événement invalide)', () => {
  it('kind hors USAGE_KINDS → BadRequestException, AUCUN insertBatch', async () => {
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([makeEvent({ kind: 'bitcoin_mining' })]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('idempotencyKey vide → BadRequest, pas d\'insert', async () => {
    // Empty key = duplicate detection cassée → double-facturation au
    // moindre retry réseau. C'est un fail-closed de la dedup.
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([makeEvent({ idempotencyKey: '' })]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('workspaceId vide → BadRequest, pas d\'insert', async () => {
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([makeEvent({ workspaceId: '' })]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('quantity NaN → BadRequest, pas d\'insert', async () => {
    // NaN dans la colonne PG numeric => SUM() retourne NaN pour TOUT
    // le workspace → dashboards de facturation cassés.
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([makeEvent({ quantity: Number.NaN })]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('quantity négative → BadRequest (anti-perte-revenu)', async () => {
    // -1000 tokens = crédit de 1000 tokens côté quota.check(). C'est
    // la dernière ligne de défense avant la DB ; au-dessus, le gRPC
    // PB autorise les int64 négatifs.
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([makeEvent({ quantity: -1 })]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('quantity = 0 est ACCEPTÉ (storage_gb_day peut être 0 pour un tenant vide)', async () => {
    // 0 n'est pas une erreur : un workspace sans fichier émet 0 GB-day.
    // Le test verrouille que le filtre est `< 0`, pas `<= 0`.
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ kind: 'storage_gb_day', quantity: 0 })]);
    expect(insertBatch).toHaveBeenCalledTimes(1);
  });

  it('si batch=[VALIDE, INVALIDE], AUCUN n\'est inséré (atomicité)', async () => {
    // CRITIQUE : un attaquant qui glisse un événement légitime à côté
    // d'un invalide ne doit pas voir le légitime persisté. La
    // validation doit boucler intégralement AVANT insertBatch.
    const { service, insertBatch } = makeMocks();
    await expect(
      service.recordUsage([
        makeEvent({ idempotencyKey: 'good' }),
        makeEvent({ idempotencyKey: 'bad', kind: 'trash' }),
      ]),
    ).rejects.toThrow(BadRequestException);
    expect(insertBatch).not.toHaveBeenCalled();
  });
});

describe('BillingService.recordUsage — normalisation userId / metadata', () => {
  it('userId undefined → null (la colonne DB refuse undefined)', async () => {
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ userId: undefined })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ userId: unknown }>;
    expect(arg[0]!.userId).toBeNull();
  });

  it('userId null → null (passthrough)', async () => {
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ userId: null })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ userId: unknown }>;
    expect(arg[0]!.userId).toBeNull();
  });

  it('userId "u-42" → "u-42" verbatim (pas de trim ni transform)', async () => {
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ userId: 'u-42' })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ userId: unknown }>;
    expect(arg[0]!.userId).toBe('u-42');
  });

  it('metadata undefined → null', async () => {
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ metadata: undefined })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ metadata: unknown }>;
    expect(arg[0]!.metadata).toBeNull();
  });

  it('metadata null → null', async () => {
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ metadata: null })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ metadata: unknown }>;
    expect(arg[0]!.metadata).toBeNull();
  });

  it('metadata {} (objet vide) est préservé tel quel — pas converti en null', async () => {
    // {} a une signification ("présent mais sans champ") différente de
    // null ("absent"). Verrouillage du `?? null` qui ne tape PAS sur {}.
    const { service, insertBatch } = makeMocks();
    await service.recordUsage([makeEvent({ metadata: {} })]);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ metadata: unknown }>;
    expect(arg[0]!.metadata).toEqual({});
  });
});

describe('BillingService.recordUsage — passthrough & métriques', () => {
  it('passe TOUS les champs verbatim à insertBatch (kind, quantity, costEurMicro, unit, occurredAt)', async () => {
    const { service, insertBatch } = makeMocks();
    const e = makeEvent({
      kind: 'embeddings_tokens',
      quantity: 1234,
      costEurMicro: 9999,
      unit: 'token',
      occurredAt: new Date('2026-04-01T10:00:00Z'),
    });
    await service.recordUsage([e]);
    const arg = insertBatch.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(arg[0]).toMatchObject({
      kind: 'embeddings_tokens',
      quantity: 1234,
      costEurMicro: 9999,
      unit: 'token',
      occurredAt: new Date('2026-04-01T10:00:00Z'),
    });
  });

  it('insertBatch est appelée UNE seule fois avec TOUS les events normalisés (ordre préservé)', async () => {
    // Anti-régression : un `for` avec un await dans la boucle ferait
    // N appels DB séquentiels (perd l'atomicité de la transaction et
    // le bénéfice du batching).
    const { service, insertBatch } = makeMocks({ accepted: 3, duplicates: 0 });
    await service.recordUsage([
      makeEvent({ idempotencyKey: 'a' }),
      makeEvent({ idempotencyKey: 'b' }),
      makeEvent({ idempotencyKey: 'c' }),
    ]);
    expect(insertBatch).toHaveBeenCalledTimes(1);
    const arg = insertBatch.mock.calls[0]![0] as Array<{ idempotencyKey: string }>;
    expect(arg.map((e) => e.idempotencyKey)).toEqual(['a', 'b', 'c']);
  });

  it('métriques.recordUsageEvents reçoit le RÉSULTAT de insertBatch, pas l\'input', async () => {
    // CRITIQUE : si on passait `events.length, 0` aux métriques, on
    // sur-compterait les "accepted" en ignorant les doublons silencieux
    // de la DB (ON CONFLICT DO NOTHING). Les métriques mentiraient
    // sur la vraie volumétrie facturable.
    const { service, recordUsageEvents } = makeMocks({ accepted: 7, duplicates: 3 });
    await service.recordUsage([makeEvent(), makeEvent({ idempotencyKey: 'b' })]);
    expect(recordUsageEvents).toHaveBeenCalledWith(7, 3);
  });

  it('retourne le BatchInsertResult verbatim (pas de remapping silencieux)', async () => {
    const { service } = makeMocks({ accepted: 5, duplicates: 2 });
    const r = await service.recordUsage([makeEvent()]);
    expect(r).toEqual({ accepted: 5, duplicates: 2 });
  });
});

describe('BillingService.checkQuota', () => {
  function makeStatus(): QuotaStatus {
    return {
      kind: 'llm_tokens',
      planCode: 'pro',
      limit: 100_000,
      used: 1_000,
      remaining: 99_000,
      periodStart: new Date('2026-05-01T00:00:00Z'),
      periodEnd: new Date('2026-06-01T00:00:00Z'),
      allowed: true,
    };
  }

  it('workspaceId vide → BadRequest sans appeler quota.check', async () => {
    const { service, quotaCheck } = makeMocks();
    await expect(service.checkQuota('', 'llm_tokens')).rejects.toThrow(BadRequestException);
    expect(quotaCheck).not.toHaveBeenCalled();
  });

  it('kind invalide → BadRequest sans appeler quota.check', async () => {
    const { service, quotaCheck } = makeMocks();
    await expect(service.checkQuota('w-1', 'nonsense')).rejects.toThrow(BadRequestException);
    expect(quotaCheck).not.toHaveBeenCalled();
  });

  it('délègue à quota.check(workspaceId, kind) avec le kind typé', async () => {
    const { service, quotaCheck } = makeMocks();
    const status = makeStatus();
    quotaCheck.mockResolvedValue(status);
    const r = await service.checkQuota('w-1', 'llm_tokens');
    expect(quotaCheck).toHaveBeenCalledWith('w-1', 'llm_tokens');
    expect(r).toBe(status);
  });

  it('propage les erreurs du QuotaService', async () => {
    const { service, quotaCheck } = makeMocks();
    quotaCheck.mockRejectedValue(new Error('subscription not found'));
    await expect(service.checkQuota('w-1', 'llm_tokens')).rejects.toThrow(
      'subscription not found',
    );
  });
});
