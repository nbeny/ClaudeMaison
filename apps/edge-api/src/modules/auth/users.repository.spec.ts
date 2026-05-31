import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import { UsersRepository, type UserRow } from './users.repository';

// UsersRepository est la couche de lookup de comptes. Invariants critiques :
//
//   - SOFT-DELETE STRICTEMENT FILTRÉ : findActiveByEmail/Id incluent
//     TOUJOURS `deleted_at IS NULL`. Sans ça, un user supprimé (RGPD,
//     compromission de compte, désinscription) pourrait se reconnecter
//     ou être ciblé par un attaquant qui a son ancien email. C'est la
//     ligne entre "compte hors-service" et "fuite par résurrection".
//
//   - createPasswordless ÉCRIT `NULL` EXPLICITE : un user OIDC-only
//     n'a JAMAIS de password_hash. Si on écrivait `''` ou `undefined`,
//     un attaquant qui devine la coercion (`bcrypt.compare('', '')`)
//     pourrait potentiellement contourner le check côté AuthService.
//     `NULL` rend le compare impossible côté Postgres ET côté code.
//
//   - LOCALE DEFAULT `'fr-FR'` : si on laissait passer `undefined`,
//     la colonne PG (NOT NULL avec default) déclencherait son default
//     côté DB — bien — mais le ROW retourné aurait `locale: null` au
//     moment du RETURNING. Le `?? 'fr-FR'` côté repo garantit que
//     le ROW retourné est complet immédiatement (utile pour les
//     viewer-resolvers qui lisent locale dès le signup).
//
//   - INSERT RENVOIE 1 LIGNE OU THROW : un RETURNING vide indique une
//     contrainte violée silencieusement ou une RLS qui filtre. Mieux
//     vaut un 500 visible qu'un JWT émis pour un user fantôme.
//
//   - PARAMÈTRE `tx` HONORÉ : les flows de signup multi-étapes
//     (create user → create workspace → create session) doivent
//     partager la même connexion pour que le rollback soit total.
//     Si `tx` était ignoré, un échec à l'étape 2 laisserait un user
//     orphelin → fuite d'emails et incohérence référentielle.
//
//   - TAGGED TEMPLATE ANTI-INJECTION : les values sont passées
//     séparément des fragments SQL. Test "email malicieux" verrouille
//     que la string n'apparaît pas dans la SQL elle-même.

interface SqlCall {
  strings: readonly string[];
  values: unknown[];
}

interface DbMock {
  db: DatabaseService;
  sql: ReturnType<typeof vi.fn>;
  calls: SqlCall[];
}

function makeDb(rowsPerCall: unknown[][] = []): DbMock {
  const calls: SqlCall[] = [];
  let callIdx = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const out = rowsPerCall[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(out);
  });
  return { db: { sql } as unknown as DatabaseService, sql, calls };
}

function makeTxMock(rowsPerCall: unknown[][] = []): {
  tx: SqlConn;
  calls: SqlCall[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: SqlCall[] = [];
  let callIdx = 0;
  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const out = rowsPerCall[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(out);
  });
  return { tx: fn as unknown as SqlConn, calls, fn };
}

function sqlOf(call: SqlCall): string {
  return call.strings.join('?');
}

function makeRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: 'u-1',
    email: 'alice@example.test',
    passwordHash: '$2a$10$abc...',
    locale: 'fr-FR',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('UsersRepository.findActiveByEmail — soft-delete strict', () => {
  it('SQL inclut WHERE email = $ AND deleted_at IS NULL', async () => {
    // CRITIQUE : sans `deleted_at IS NULL`, un user RGPD-supprimé
    // pourrait être resigné si l'email est repris.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.findActiveByEmail('alice@example.test');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/FROM\s+auth\.users/i);
    expect(sql).toMatch(/email\s*=/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
  });

  it('interpole l\'email comme paramètre lié (anti-injection)', async () => {
    // Lock-in : une string malicieuse arrive dans `values`, JAMAIS
    // dans les fragments SQL.
    const { db, calls } = makeDb([[]]);
    const repo = new UsersRepository(db);
    const malicious = "'; DROP TABLE auth.users; --";
    await repo.findActiveByEmail(malicious);
    expect(calls[0]!.values).toEqual([malicious]);
    expect(sqlOf(calls[0]!)).not.toContain('DROP TABLE');
  });

  it('retourne null si aucune ligne (pas undefined, pas throw)', async () => {
    const { db } = makeDb([[]]);
    const repo = new UsersRepository(db);
    expect(await repo.findActiveByEmail('ghost@x')).toBeNull();
  });

  it('retourne la ligne complète si trouvée', async () => {
    const row = makeRow({ id: 'u-42', email: 'bob@x', passwordHash: null });
    const { db } = makeDb([[row]]);
    const repo = new UsersRepository(db);
    expect(await repo.findActiveByEmail('bob@x')).toEqual(row);
  });

  it('utilise `tx` quand fourni (cohérence transactionnelle)', async () => {
    // CRITIQUE : un signup atomique fait user+workspace+session dans
    // une seule transaction. Si tx était ignoré, on lookerait
    // l'utilisateur sur la connexion default → MVCC ne voit pas
    // l'INSERT en cours → unique-conflict false-positive.
    const { db, sql: defaultSql } = makeDb();
    const { tx, calls: txCalls, fn: txFn } = makeTxMock([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.findActiveByEmail('alice@x', tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
    expect(txCalls[0]!.values).toEqual(['alice@x']);
  });
});

describe('UsersRepository.findActiveById — soft-delete strict', () => {
  it('SQL inclut WHERE id = $ AND deleted_at IS NULL + LIMIT 1', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new UsersRepository(db);
    await repo.findActiveById('u-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/WHERE\s+id\s*=/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
    expect(calls[0]!.values).toEqual(['u-1']);
  });

  it('retourne null si supprimé ou absent', async () => {
    const { db } = makeDb([[]]);
    const repo = new UsersRepository(db);
    expect(await repo.findActiveById('u-deleted')).toBeNull();
  });

  it('honore tx quand fourni', async () => {
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn } = makeTxMock([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.findActiveById('u-1', tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
  });
});

describe('UsersRepository.createWithPassword', () => {
  it('interpole email, password_hash, locale dans cet ordre', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createWithPassword({
      email: 'new@x',
      passwordHash: '$2a$10$xyz',
      locale: 'en-US',
    });
    expect(calls[0]!.values).toEqual(['new@x', '$2a$10$xyz', 'en-US']);
  });

  it("defaulte locale à 'fr-FR' si absente (le ROW retourné est complet)", async () => {
    // Sans ce default, le RETURNING reflète le default DB mais le
    // viewer-resolver qui lit `locale` immédiatement après signup
    // verrait `null` en mémoire.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createWithPassword({ email: 'x@x', passwordHash: 'h' });
    expect(calls[0]!.values[2]).toBe('fr-FR');
  });

  it("locale '' (string vide) NON remplacée par défaut — passthrough", async () => {
    // `?? 'fr-FR'` ne tape que sur null/undefined. Lock-in : si le
    // caller a une raison de passer ``, c'est passé tel quel (la DB
    // CHECK refusera, c'est sa job).
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createWithPassword({
      email: 'x@x',
      passwordHash: 'h',
      locale: '',
    });
    expect(calls[0]!.values[2]).toBe('');
  });

  it('SQL contient INSERT INTO auth.users + RETURNING', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createWithPassword({ email: 'x@x', passwordHash: 'h' });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/INSERT\s+INTO\s+auth\.users/i);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('retourne le ROW du RETURNING', async () => {
    const row = makeRow({ id: 'u-new', email: 'x@x' });
    const { db } = makeDb([[row]]);
    const repo = new UsersRepository(db);
    expect(await repo.createWithPassword({ email: 'x@x', passwordHash: 'h' })).toEqual(row);
  });

  it('THROW si 0 ligne retournée (anti-user-fantôme)', async () => {
    const { db } = makeDb([[]]);
    const repo = new UsersRepository(db);
    await expect(
      repo.createWithPassword({ email: 'x@x', passwordHash: 'h' }),
    ).rejects.toThrow(/0 ligne/);
  });

  it('honore tx (signup atomique)', async () => {
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn } = makeTxMock([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createWithPassword({ email: 'x@x', passwordHash: 'h' }, tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
  });
});

describe('UsersRepository.createPasswordless — anti-local-signin pour OIDC', () => {
  it('SQL écrit `NULL` LITTÉRAL pour password_hash (pas $ binding)', async () => {
    // CRITIQUE : un user OIDC-only NE DOIT JAMAIS avoir un hash.
    // Si on bindait `null` via ${input.passwordHash ?? null}, la
    // valeur null arriverait via paramètre. C'est OK fonctionnellement
    // mais on lock-in le pattern "NULL hard-codé dans le SQL" parce
    // que c'est plus lisible côté audit DB et impossible à
    // accidentellement remplacer par un hash réel.
    const { db, calls } = makeDb([[makeRow({ passwordHash: null })]]);
    const repo = new UsersRepository(db);
    await repo.createPasswordless({ email: 'oidc@x' });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/VALUES\s*\(\s*\?\s*,\s*NULL\s*,/i);
    // Les values ne contiennent QUE email + locale, JAMAIS un hash.
    expect(calls[0]!.values).toEqual(['oidc@x', 'fr-FR']);
  });

  it("locale defaulte à 'fr-FR' (cohérence avec createWithPassword)", async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createPasswordless({ email: 'x@x' });
    expect(calls[0]!.values[1]).toBe('fr-FR');
  });

  it('locale fournie est utilisée verbatim', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new UsersRepository(db);
    await repo.createPasswordless({ email: 'x@x', locale: 'de-DE' });
    expect(calls[0]!.values).toEqual(['x@x', 'de-DE']);
  });

  it('retourne le ROW du RETURNING avec passwordHash = null', async () => {
    const row = makeRow({ id: 'u-oidc', passwordHash: null });
    const { db } = makeDb([[row]]);
    const repo = new UsersRepository(db);
    const out = await repo.createPasswordless({ email: 'x@x' });
    expect(out.passwordHash).toBeNull();
  });

  it('THROW si 0 ligne (anti-user-OIDC-fantôme)', async () => {
    const { db } = makeDb([[]]);
    const repo = new UsersRepository(db);
    await expect(repo.createPasswordless({ email: 'x@x' })).rejects.toThrow(/0 ligne/);
  });

  it('honore tx (OIDC callback transactionnel)', async () => {
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn } = makeTxMock([[makeRow({ passwordHash: null })]]);
    const repo = new UsersRepository(db);
    await repo.createPasswordless({ email: 'x@x' }, tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
  });
});
