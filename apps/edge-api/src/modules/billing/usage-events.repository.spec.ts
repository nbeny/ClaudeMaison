import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import {
  UsageEventsRepository,
  type UsageEventInput,
} from './usage-events.repository';

// UsageEventsRepository est la couche d'écriture des événements
// facturables. Ses invariants sont financiers et tournent autour de
// trois garanties dures :
//
//   - ALL-OR-NOTHING : insertBatch wrap toutes les écritures dans
//     `db.sql.begin(fn)`. Si un INSERT plante au milieu, AUCUN n'est
//     visible côté lecteur — on ne facture pas un sous-ensemble
//     fantôme d'un appel gRPC.
//
//   - DÉDUPLICATION PAR `idempotency_key` : ON CONFLICT DO NOTHING
//     RETURNING id. Le RETURNING vide = doublon ignoré silencieusement,
//     RETURNING avec id = nouvel insert. Sans cette dedup, un retry
//     réseau (client gRPC reprend après timeout) facturerait deux
//     fois la même consommation.
//
//   - METADATA SÉRIALISÉE EN JSONB via `tx.json` : un objet brut
//     dans une tagged template arriverait en text Postgres et le
//     CAST côté DB rejetterait l'insert. `tx.json(metadata ?? null)`
//     est la conversion idiomatique de postgres.js. null préservé.
//
//   - sumQuantity AVEC `::text` : SUM(NUMERIC) en pure JS perdrait
//     la précision sur de gros volumes. Le cast text + Number côté
//     repo conserve la précision dans la plage Jour-1 et signale
//     une overflow potentielle si on dépasse Number.MAX_SAFE_INTEGER.
//
//   - INTERVAL HALF-OPEN `[periodStart, periodEnd)` : occurred_at
//     >= start AND occurred_at < end. Si on faisait `<=`, un événement
//     à 23:59:59.999 du dernier jour serait compté DANS DEUX
//     périodes consécutives → double-facturation aux frontières
//     mois/semaine. Lock strict.
//
//   - NULL total → 0 : un workspace sans événement sur la période
//     doit renvoyer 0, pas null, pas NaN. C'est ce qu'un quota
//     check attend pour calculer `remaining`.

interface SqlCall {
  strings: readonly string[];
  values: unknown[];
}

interface TxMock {
  fn: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  calls: SqlCall[];
}

interface DbMock {
  db: DatabaseService;
  sql: ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
  };
  tx: TxMock;
  /** Toutes les calls (top-level + dans tx), dans l'ordre. */
  calls: SqlCall[];
  beginCalls: number;
}

/**
 * Construit un mock complet de DatabaseService :
 *   - `db.sql` est une tagged-template-function
 *   - `db.sql.begin(fn)` invoque fn(tx)
 *   - `tx` est aussi une tagged-template-function et expose `tx.json(v)`
 * On enregistre toutes les calls dans `calls` et on programme les
 * lignes RETURNING dans `rowsPerCall`.
 */
function makeDb(rowsPerCall: unknown[][] = []): DbMock {
  const calls: SqlCall[] = [];
  let callIdx = 0;
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const out = rowsPerCall[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(out);
  };

  const txCalls: SqlCall[] = [];
  const txFn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ strings: [...strings], values });
    return record(strings, values);
  });
  const txJson = vi.fn((v: unknown) => ({ __json: v }));
  // tx est la fonction tagged-template ET expose .json
  const tx = Object.assign(txFn, { json: txJson });

  const sqlFn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
    record(strings, values),
  );
  let beginCalls = 0;
  const beginFn = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
    beginCalls++;
    return cb(tx);
  });
  const sql = Object.assign(sqlFn, { begin: beginFn });

  return {
    db: { sql } as unknown as DatabaseService,
    sql: sql as DbMock['sql'],
    tx: { fn: txFn, json: txJson, calls: txCalls },
    calls,
    get beginCalls() {
      return beginCalls;
    },
  };
}

function sqlOf(call: SqlCall): string {
  return call.strings.join('?');
}

function makeEvent(over: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    idempotencyKey: 'idem-1',
    workspaceId: 'w-1',
    userId: 'u-1',
    kind: 'llm_tokens',
    quantity: 100,
    unit: 'tokens',
    costEurMicro: 50,
    occurredAt: new Date('2026-05-31T12:00:00Z'),
    metadata: { model: 'mistral-7b' },
    ...over,
  };
}

describe('UsageEventsRepository.insertBatch — chemin vide', () => {
  it('events=[] → {0,0} SANS toucher begin() ni l\'execution SQL', async () => {
    // Critique : un begin() inutile démarre une vraie transaction PG
    // (un slot du pool, un xid, des locks). Le chemin vide doit
    // court-circuiter complètement.
    const m = makeDb();
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.insertBatch([]);
    expect(r).toEqual({ accepted: 0, duplicates: 0 });
    expect(m.beginCalls).toBe(0);
    expect(m.sql).not.toHaveBeenCalled();
    expect(m.tx.fn).not.toHaveBeenCalled();
  });
});

describe('UsageEventsRepository.insertBatch — transaction & dedup', () => {
  it('wrap dans db.sql.begin() (all-or-nothing)', async () => {
    // Lock-in : si on remplaçait begin() par des INSERT directs sur
    // db.sql, un crash au milieu laisserait un sous-batch facturé.
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent()]);
    expect(m.beginCalls).toBe(1);
    expect(m.tx.fn).toHaveBeenCalledTimes(1);
    // Aucun INSERT n'a fuité hors de la transaction.
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('1 inséré (RETURNING avec id) → {accepted:1, duplicates:0}', async () => {
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.insertBatch([makeEvent()]);
    expect(r).toEqual({ accepted: 1, duplicates: 0 });
  });

  it('1 doublon (RETURNING vide) → {accepted:0, duplicates:1}', async () => {
    // CRITIQUE : ON CONFLICT DO NOTHING signifie que le doublon ne
    // raise PAS. La seule façon de le détecter côté code est
    // RETURNING vide. Si on lisait `inserted.length === 1` à l'envers,
    // on compterait le doublon comme accepté → facturé deux fois.
    const m = makeDb([[]]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.insertBatch([makeEvent()]);
    expect(r).toEqual({ accepted: 0, duplicates: 1 });
  });

  it('mix : 2 insérés + 1 doublon → {accepted:2, duplicates:1}', async () => {
    const m = makeDb([
      [{ id: 'a' }], //  inséré
      [], //             doublon
      [{ id: 'c' }], //  inséré
    ]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.insertBatch([
      makeEvent({ idempotencyKey: 'a' }),
      makeEvent({ idempotencyKey: 'b' }),
      makeEvent({ idempotencyKey: 'c' }),
    ]);
    expect(r).toEqual({ accepted: 2, duplicates: 1 });
  });

  it('SQL contient ON CONFLICT (idempotency_key) DO NOTHING + RETURNING id', async () => {
    // Triple lock-in : le nom de la colonne (anti-rename silencieux
    // qui transformerait la dedup en explosion d'erreurs), le DO
    // NOTHING (anti DO UPDATE qui écraserait l'event original) et
    // le RETURNING id (anti RETURNING * qui changerait le coût).
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent()]);
    const sql = sqlOf(m.tx.calls[0]!);
    expect(sql).toMatch(/INSERT\s+INTO\s+billing\.usage_events/i);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*idempotency_key\s*\)\s+DO\s+NOTHING/i);
    expect(sql).toMatch(/RETURNING\s+id\b/i);
  });

  it('ordre des values respecte l\'ordre des colonnes (anti-shuffle qui inverserait quantity et cost)', async () => {
    // Si quelqu'un swappait quantity et cost_eur_micro en éditant,
    // on facturerait des centimes au lieu de tokens. Lock l'ordre
    // attendu par le SQL : (idempotencyKey, workspaceId, userId,
    // kind, quantity, unit, costEurMicro, metadata wrapped, occurredAt).
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    const e = makeEvent({
      idempotencyKey: 'K',
      workspaceId: 'W',
      userId: 'U',
      kind: 'tool_runs',
      quantity: 7,
      unit: 'runs',
      costEurMicro: 42,
      metadata: { tag: 'x' },
      occurredAt: new Date('2026-04-01T00:00:00Z'),
    });
    await repo.insertBatch([e]);
    const vals = m.tx.calls[0]!.values;
    expect(vals[0]).toBe('K');
    expect(vals[1]).toBe('W');
    expect(vals[2]).toBe('U');
    expect(vals[3]).toBe('tool_runs');
    expect(vals[4]).toBe(7);
    expect(vals[5]).toBe('runs');
    expect(vals[6]).toBe(42);
    // metadata est wrapped par tx.json
    expect(vals[7]).toEqual({ __json: { tag: 'x' } });
    expect(vals[8]).toEqual(new Date('2026-04-01T00:00:00Z'));
  });

  it('metadata via tx.json() — JSONB wrapping (pas text-coerce silencieux)', async () => {
    // CRITIQUE : sans tx.json, postgres.js interpole un object via
    // String() → "[object Object]" en colonne JSONB → CAST error
    // côté PG. Le test verrouille que tx.json est bien appelée.
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent({ metadata: { k: 'v' } })]);
    expect(m.tx.json).toHaveBeenCalledWith({ k: 'v' });
  });

  it('metadata undefined → tx.json(null) (cohérence repo : null en DB)', async () => {
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent({ metadata: undefined })]);
    expect(m.tx.json).toHaveBeenCalledWith(null);
  });

  it('metadata null → tx.json(null) (passthrough)', async () => {
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent({ metadata: null })]);
    expect(m.tx.json).toHaveBeenCalledWith(null);
  });

  it('userId null est interpolé verbatim (event système sans user attaché)', async () => {
    // Certains événements (batch nightly, ingestion auto) n'ont pas
    // de user. La colonne accepte NULL. Lock-in : on n'écrit pas
    // une string "null" par accident.
    const m = makeDb([[{ id: 'i-1' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([makeEvent({ userId: null })]);
    expect(m.tx.calls[0]!.values[2]).toBeNull();
  });

  it('N events → N appels à tx, dans le MÊME begin (une seule transaction)', async () => {
    // Anti-régression : un Promise.all() qui paralleliserait dans
    // une boucle perdrait l'ordre ; un begin() par event ouvrirait
    // N transactions. Lock-in : 1 begin, N tx calls dans l'ordre.
    const m = makeDb([[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.insertBatch([
      makeEvent({ idempotencyKey: 'a' }),
      makeEvent({ idempotencyKey: 'b' }),
      makeEvent({ idempotencyKey: 'c' }),
    ]);
    expect(m.beginCalls).toBe(1);
    expect(m.tx.fn).toHaveBeenCalledTimes(3);
    expect(m.tx.calls.map((c) => c.values[0])).toEqual(['a', 'b', 'c']);
  });
});

describe('UsageEventsRepository.sumQuantity', () => {
  it("SQL utilise SUM(quantity)::text (anti precision-loss sur gros NUMERIC)", async () => {
    // Sans ::text, postgres.js coerce SUM(NUMERIC) en string ou number
    // selon la version. Le ::text + Number côté repo rend le contrat
    // déterministe et évite que SUM > Number.MAX_SAFE_INTEGER plante
    // silencieusement.
    const m = makeDb([[{ total: '12345' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.sumQuantity({
      workspaceId: 'w-1',
      kind: 'llm_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    const sql = sqlOf(m.calls[0]!);
    expect(sql).toMatch(/SUM\(\s*quantity\s*\)\s*::\s*text/i);
  });

  it("interval HALF-OPEN [start, end) : occurred_at >= start AND occurred_at < end", async () => {
    // CRITIQUE : un < fin (pas <=) garantit qu'un event à 23:59:59.999
    // du 31 mai n'est PAS compté à la fois dans mai et juin. Lock
    // strict — un copy/paste qui mettrait `<=` doublerait la
    // facturation aux frontières de période.
    const m = makeDb([[{ total: '0' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.sumQuantity({
      workspaceId: 'w-1',
      kind: 'llm_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    const sql = sqlOf(m.calls[0]!);
    expect(sql).toMatch(/occurred_at\s*>=/);
    expect(sql).toMatch(/occurred_at\s*<\s*\?/); // STRICT, pas <=
    expect(sql).not.toMatch(/occurred_at\s*<=/);
  });

  it("filtre par workspace_id ET kind (anti cross-tenant et cross-kind)", async () => {
    // Sans le filtre workspace_id, un tenant verrait la conso d'un
    // autre. Sans le filtre kind, llm_tokens additionnerait
    // embeddings_tokens dans son quota.
    const m = makeDb([[{ total: '0' }]]);
    const repo = new UsageEventsRepository(m.db);
    await repo.sumQuantity({
      workspaceId: 'w-X',
      kind: 'embeddings_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    const sql = sqlOf(m.calls[0]!);
    expect(sql).toMatch(/workspace_id\s*=/);
    expect(sql).toMatch(/kind\s*=/);
    expect(m.calls[0]!.values).toEqual([
      'w-X',
      'embeddings_tokens',
      new Date('2026-05-01'),
      new Date('2026-06-01'),
    ]);
  });

  it("total null → 0 (workspace sans événement, pas NaN, pas null)", async () => {
    // Sans le `?? null` puis `=== null ? 0`, on aurait `Number(null)
    // = 0` côté JS — ça marche par coïncidence. Mais le test verrouille
    // l'intention : QuotaService attend un number, pas un null.
    const m = makeDb([[{ total: null }]]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.sumQuantity({
      workspaceId: 'w-1',
      kind: 'llm_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    expect(r).toBe(0);
  });

  it("aucune ligne (rows=[]) → 0", async () => {
    // SUM avec 0 lignes renvoie quand même 1 ligne {total: null} en
    // PG, mais un mock incomplet pourrait renvoyer []. Verrouillage
    // défensif.
    const m = makeDb([[]]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.sumQuantity({
      workspaceId: 'w-1',
      kind: 'llm_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    expect(r).toBe(0);
  });

  it("total '12345' (string PG) → 12345 (number)", async () => {
    const m = makeDb([[{ total: '12345' }]]);
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.sumQuantity({
      workspaceId: 'w-1',
      kind: 'llm_tokens',
      periodStart: new Date('2026-05-01'),
      periodEnd: new Date('2026-06-01'),
    });
    expect(r).toBe(12345);
    expect(typeof r).toBe('number');
  });

  it("honore `tx` quand fourni (lecture dans la même transaction qu'une écriture)", async () => {
    // Les flows quota check + record dans une transaction partagent
    // tx pour lire la consommation à jour (sinon REPEATABLE READ ne
    // verrait pas les writes en cours).
    const m = makeDb();
    const txCalls: SqlCall[] = [];
    const tx = vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        txCalls.push({ strings: [...strings], values });
        return Promise.resolve([{ total: '99' }]);
      },
    );
    const repo = new UsageEventsRepository(m.db);
    const r = await repo.sumQuantity(
      {
        workspaceId: 'w-1',
        kind: 'llm_tokens',
        periodStart: new Date('2026-05-01'),
        periodEnd: new Date('2026-06-01'),
      },
      tx as unknown as SqlConn,
    );
    expect(tx).toHaveBeenCalledTimes(1);
    expect(m.sql).not.toHaveBeenCalled();
    expect(r).toBe(99);
  });
});
