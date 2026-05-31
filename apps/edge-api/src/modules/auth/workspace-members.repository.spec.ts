import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import { WorkspaceMembersRepository } from './workspace-members.repository';

// WorkspaceMembersRepository.isMember est l'invariant ACL pour TOUT accès
// à une ressource workspace-scopée (billing, conversations, usage). Deux
// invariants critiques verrouillés :
//
//   - Compound clause `workspace_id = $ AND user_id = $` : sans le filtre
//     user_id, un membre d'un workspace pourrait passer pour membre de
//     tous les workspaces (collision sur workspace_id seul). Sans le
//     filtre workspace_id, un user membre d'un seul workspace passerait
//     pour membre de tous.
//
//   - Comparaison `=== true` STRICTE sur le retour EXISTS : si on
//     remplace par `?? false` ou par truthy, un retour anormal de la DB
//     (string 'f', objet {}, etc.) ferait passer un non-membre pour
//     membre. EXISTS PostgreSQL renvoie un boolean ; postgres.js doit le
//     mapper sur boolean, mais une régression de driver ou un UNION mal
//     placé renverrait autre chose. La comparaison stricte est la
//     ceinture-bretelles.

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

describe('WorkspaceMembersRepository.isMember', () => {
  it('retourne true quand la ligne EXISTS = true', async () => {
    const { db } = makeDb([[{ exists: true }]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1')).toBe(true);
  });

  it('retourne false quand EXISTS = false', async () => {
    const { db } = makeDb([[{ exists: false }]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1')).toBe(false);
  });

  it('retourne false quand aucune ligne renvoyée (fail-closed)', async () => {
    const { db } = makeDb([[]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1')).toBe(false);
  });

  it('retourne false sur valeur truthy non-true (anti-coerce-string)', async () => {
    // Comparaison stricte `=== true` : 'true' (string), 1, {} ne doivent
    // PAS passer pour membre. C'est la ceinture-bretelles.
    const { db } = makeDb([[{ exists: 'true' as unknown as boolean }]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1')).toBe(false);
  });

  it('retourne false sur exists undefined (champ manquant)', async () => {
    const { db } = makeDb([[{} as { exists: boolean }]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1')).toBe(false);
  });

  it('filtre compound workspace_id ET user_id dans le SQL', async () => {
    const { db, calls } = makeDb([[{ exists: false }]]);
    const repo = new WorkspaceMembersRepository(db);

    await repo.isMember('ws-1', 'u-1');

    const sql = sqlOf(calls[0]);
    expect(sql).toMatch(/workspace_id\s*=\s*\?/);
    expect(sql).toMatch(/user_id\s*=\s*\?/);
    expect(sql).toMatch(/AND/i);
  });

  it('contient EXISTS dans le SQL (pattern boolean exists)', async () => {
    const { db, calls } = makeDb([[{ exists: false }]]);
    const repo = new WorkspaceMembersRepository(db);

    await repo.isMember('ws-1', 'u-1');

    expect(sqlOf(calls[0])).toMatch(/EXISTS/i);
  });

  it('ordre des binds : workspaceId puis userId', async () => {
    const { db, calls } = makeDb([[{ exists: false }]]);
    const repo = new WorkspaceMembersRepository(db);

    await repo.isMember('ws-42', 'u-99');

    expect(calls[0].values).toEqual(['ws-42', 'u-99']);
  });

  it('valeurs paramétrées (anti-injection)', async () => {
    const { db, calls } = makeDb([[{ exists: false }]]);
    const repo = new WorkspaceMembersRepository(db);

    const malicious = "' OR '1'='1";
    await repo.isMember(malicious, malicious);

    expect(calls[0].values).toEqual([malicious, malicious]);
    expect(sqlOf(calls[0])).not.toContain("OR '1'='1");
  });

  it('utilise tx quand fourni', async () => {
    const { db } = makeDb([]);
    const { tx, calls } = makeTxMock([[{ exists: true }]]);
    const repo = new WorkspaceMembersRepository(db);

    expect(await repo.isMember('ws-1', 'u-1', tx)).toBe(true);

    expect(calls).toHaveLength(1);
    expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
