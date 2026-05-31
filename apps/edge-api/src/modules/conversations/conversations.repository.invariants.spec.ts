import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import { ConversationsRepository, type ConversationRow } from './conversations.repository';

// Caractérisation ConversationsRepository — invariants NON couverts par
// conversations.repository.spec.ts (1 test trivial). On verrouille les
// invariants SQL critiques en interceptant le tag template `sql` :
//
//   - Soft-delete filter `deleted_at IS NULL` dans findById ET
//     listByWorkspace : une conversation marquée supprimée NE DOIT JAMAIS
//     remonter (RGPD-compatible + UX prédictible).
//
//   - ORDER BY updated_at DESC dans listByWorkspace : c'est la promesse
//     UX "dernière conv en haut". DESC → ASC casserait l'ordonnancement.
//
//   - LIMIT 50 par défaut : sans plafond implicite, un workspace avec
//     10 000 conversations ferait exploser la sérialisation GraphQL.
//
//   - LIMIT propagé quand l'appelant en fournit un (exports).
//
//   - create() jette si INSERT ne renvoie pas exactement 1 ligne
//     (anti-corruption silencieuse de l'état applicatif).
//
//   - model/title : `undefined` → bind `null` (pas `'undefined'` ni le
//     placeholder vide). Postgres NULL est sémantiquement "non choisi".
//
//   - tx override forwarde sur les 4 méthodes : utiliser tx au lieu de
//     this.db.sql, sinon les insertions/lectures sortent de la
//     transaction et brisent l'atomicité d'une mutation composite.
//
//   - touchUpdatedAt utilise `SET updated_at = now()` (côté DB, pas Date
//     côté Node) : sinon le clock-skew d'un worker pourrait écrire une
//     date dans le passé / futur incohérente avec les autres rows.
//
//   - Column aliasing snake_case → camelCase exact dans le SELECT
//     (workspace_id AS "workspaceId", etc.). Une faute de frappe →
//     champ undefined côté GraphQL → field nulled silencieusement.

type Call = { strings: TemplateStringsArray; values: unknown[] };

function makeDb(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
  });
  return {
    db: { sql } as unknown as DatabaseService,
    sql,
    calls,
  };
}

function makeTxMock(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
  }) as unknown as SqlConn;
  return { tx, calls };
}

const sqlOf = (c: Call) => c.strings.join('?');

const SAMPLE: ConversationRow = {
  id: 'conv-1',
  workspaceId: 'ws-1',
  createdBy: 'user-1',
  title: null,
  model: null,
  createdAt: new Date('2026-05-31T10:00:00Z'),
  updatedAt: new Date('2026-05-31T10:00:00Z'),
};

describe('ConversationsRepository.create — INSERT + RETURNING', () => {
  it('retourne la ligne mappée RETURNING quand 1 row remonte', async () => {
    const { db } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    const row = await repo.create({ workspaceId: 'ws-1', createdBy: 'user-1' });
    expect(row).toEqual(SAMPLE);
  });

  it('jette une Error explicite si l\'INSERT renvoie 0 ligne (anti-corruption silencieuse)', async () => {
    // Sans ce throw, le service appelant continuerait avec un undefined
    // qui se propagerait jusqu'au resolver GraphQL, où il deviendrait un
    // 500 opaque sans info de debug.
    const { db } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    await expect(
      repo.create({ workspaceId: 'ws-1', createdBy: 'user-1' }),
    ).rejects.toThrow(/INSERT.*0 ligne/);
  });

  it('bind model=null quand le caller ne fournit pas model (pas undefined ni vide)', async () => {
    // L'ordre des binds doit être (workspaceId, createdBy, model, title).
    // Le ?? null normalise undefined → null pour Postgres.
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.create({ workspaceId: 'ws-1', createdBy: 'user-1' });
    expect(calls[0]!.values).toEqual(['ws-1', 'user-1', null, null]);
  });

  it('bind model fourni propagé tel quel', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.create({
      workspaceId: 'ws-1',
      createdBy: 'user-1',
      model: 'mistral-7b',
      title: 'Titre',
    });
    expect(calls[0]!.values).toEqual(['ws-1', 'user-1', 'mistral-7b', 'Titre']);
  });

  it('le SQL utilise bien INSERT INTO conversations.conversations (4 colonnes) + RETURNING', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.create({ workspaceId: 'ws-1', createdBy: 'user-1' });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/INSERT\s+INTO\s+conversations\.conversations/i);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('column aliasing snake→camel exact dans le RETURNING', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.create({ workspaceId: 'ws-1', createdBy: 'user-1' });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/workspace_id\s+AS\s+"workspaceId"/i);
    expect(sql).toMatch(/created_by\s+AS\s+"createdBy"/i);
    expect(sql).toMatch(/created_at\s+AS\s+"createdAt"/i);
    expect(sql).toMatch(/updated_at\s+AS\s+"updatedAt"/i);
  });
});

describe('ConversationsRepository.findById — soft-delete filter', () => {
  it('exclut les rows soft-deleted (WHERE deleted_at IS NULL)', async () => {
    // Si on retire ce filtre, un user qui supprime une conv la voit
    // ressurgir au refresh, et le membre récemment retiré peut encore
    // y accéder via son ID si on a court-circuité l'ACL ailleurs.
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.findById('conv-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('WHERE id = bind paramétré (anti-SQL-injection — pas de string concat)', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.findById("malicieux'--");
    expect(calls[0]!.values).toContain("malicieux'--");
  });

  it('retourne null quand aucune row ne matche', async () => {
    const { db } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    expect(await repo.findById('inconnu')).toBeNull();
  });

  it('retourne la première row quand plusieurs remontent (cas pathologique mais lock)', async () => {
    const { db } = makeDb([[SAMPLE, { ...SAMPLE, id: 'conv-2' }]]);
    const repo = new ConversationsRepository(db);
    const row = await repo.findById('conv-1');
    expect(row!.id).toBe('conv-1');
  });

  it('column aliasing snake→camel exact dans le SELECT', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.findById('x');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/workspace_id\s+AS\s+"workspaceId"/i);
    expect(sql).toMatch(/created_by\s+AS\s+"createdBy"/i);
    expect(sql).toMatch(/created_at\s+AS\s+"createdAt"/i);
    expect(sql).toMatch(/updated_at\s+AS\s+"updatedAt"/i);
  });
});

describe('ConversationsRepository.listByWorkspace — soft-delete + ordering + LIMIT', () => {
  it('filtre les rows soft-deleted (deleted_at IS NULL)', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace('ws-1');
    expect(sqlOf(calls[0]!)).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it('ORDER BY updated_at DESC (dernière conv en haut)', async () => {
    // Inverser en ASC ferait apparaître la conv la plus ANCIENNE en
    // haut de la liste UI — régression visible mais après que des users
    // se soient plaints. Lock-in préventif.
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace('ws-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/ORDER\s+BY\s+updated_at\s+DESC/i);
    expect(sql).not.toMatch(/ORDER\s+BY\s+updated_at\s+ASC/i);
  });

  it('LIMIT 50 par défaut quand non spécifié', async () => {
    // Sans ce plafond implicite, un workspace de 10 000 convs explose
    // la sérialisation GraphQL. 50 est conservateur ; un override
    // explicite reste possible.
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace('ws-1');
    // Le LIMIT est passé en bind ; vérifier qu'il vaut 50.
    expect(calls[0]!.values).toContain(50);
  });

  it('LIMIT propagé en bind quand l\'appelant en fournit un', async () => {
    const { db, calls } = makeDb([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace('ws-1', 200);
    expect(calls[0]!.values).toContain(200);
    expect(calls[0]!.values).not.toContain(50); // pas de fallback parasite
  });

  it('WHERE workspace_id = bind paramétré (pas de string concat)', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace("' OR 1=1 --");
    expect(calls[0]!.values).toContain("' OR 1=1 --");
  });

  it('retourne le tableau brut renvoyé par sql (pas de filtre supplémentaire)', async () => {
    const rows = [SAMPLE, { ...SAMPLE, id: 'conv-2' }];
    const { db } = makeDb([rows]);
    const repo = new ConversationsRepository(db);
    const out = await repo.listByWorkspace('ws-1');
    expect(out).toEqual(rows);
  });
});

describe('ConversationsRepository.touchUpdatedAt — clock côté DB', () => {
  it('utilise now() côté Postgres (pas de Date envoyée depuis Node)', async () => {
    // Le clock applicatif peut diverger entre workers. Utiliser now()
    // côté DB garantit que tous les SET updated_at viennent du même
    // horloge monotone. Lock du choix architectural.
    const { db, calls } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    await repo.touchUpdatedAt('conv-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/SET\s+updated_at\s*=\s*now\(\)/i);
  });

  it('bind id paramétré (anti SQL-injection)', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    await repo.touchUpdatedAt("'; DROP TABLE x; --");
    expect(calls[0]!.values).toEqual(["'; DROP TABLE x; --"]);
  });

  it('ne renvoie rien (Promise<void>)', async () => {
    const { db } = makeDb([[]]);
    const repo = new ConversationsRepository(db);
    const result = await repo.touchUpdatedAt('conv-1');
    expect(result).toBeUndefined();
  });
});

describe('ConversationsRepository — tx override forwardé sur les 4 méthodes', () => {
  it('create(tx) utilise tx au lieu de this.db.sql', async () => {
    // Sans cette propagation, une mutation composite qui utilise une
    // transaction (ex: sendMessage qui insère user-msg + assistant-msg)
    // ferait sortir le create() de la transaction → l'INSERT serait
    // committé même si le reste rollback.
    const { db, sql: dbSql } = makeDb([]);
    const { tx, calls: txCalls } = makeTxMock([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.create({ workspaceId: 'w', createdBy: 'u' }, tx);
    expect(dbSql).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(1);
  });

  it('findById(tx) utilise tx au lieu de this.db.sql', async () => {
    const { db, sql: dbSql } = makeDb([]);
    const { tx, calls: txCalls } = makeTxMock([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.findById('conv-1', tx);
    expect(dbSql).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(1);
  });

  it('listByWorkspace(tx) utilise tx au lieu de this.db.sql', async () => {
    const { db, sql: dbSql } = makeDb([]);
    const { tx, calls: txCalls } = makeTxMock([[SAMPLE]]);
    const repo = new ConversationsRepository(db);
    await repo.listByWorkspace('ws-1', 50, tx);
    expect(dbSql).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(1);
  });

  it('touchUpdatedAt(tx) utilise tx au lieu de this.db.sql', async () => {
    const { db, sql: dbSql } = makeDb([]);
    const { tx, calls: txCalls } = makeTxMock([[]]);
    const repo = new ConversationsRepository(db);
    await repo.touchUpdatedAt('conv-1', tx);
    expect(dbSql).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(1);
  });

  it('sans tx, les 4 méthodes utilisent this.db.sql (chemin nominal)', async () => {
    const { db, sql: dbSql } = makeDb([[SAMPLE], [SAMPLE], [SAMPLE], []]);
    const repo = new ConversationsRepository(db);
    await repo.create({ workspaceId: 'w', createdBy: 'u' });
    await repo.findById('conv-1');
    await repo.listByWorkspace('ws-1');
    await repo.touchUpdatedAt('conv-1');
    expect(dbSql).toHaveBeenCalledTimes(4);
  });
});
