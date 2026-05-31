import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import {
  FederatedIdentitiesRepository,
  type FederatedIdentityRow,
} from './federated-identities.repository';

// FederatedIdentitiesRepository est le pont OIDC↔user-local. Ses
// invariants critiques sont des invariants de sécurité multi-IdP :
//
//   - LOOKUP PAR COMPOUND (provider, subject) : un subject=42 chez
//     Keycloak A n'est PAS la même identité qu'un subject=42 chez
//     Keycloak B (Google, GitHub, Entra…). Le subject est une string
//     opaque dont l'unicité n'est garantie QUE par provider. Si on
//     lookait par subject seul, un attaquant qui contrôle un IdP
//     custom pourrait forger un token avec `sub=<subject d'un user
//     existant>` et se faire passer pour lui. Lock-in dur.
//
//   - `last_login = now()` AU INSERT : la convention est "createdAt
//     ≈ last_login lors du premier login". Ça permet aux dashboards
//     ops de détecter les comptes OIDC créés mais jamais utilisés
//     activement sans avoir à JOIN une table d'audit.
//
//   - email NULLABLE et PRÉSERVÉ : certains IdP (GitHub avec email
//     privé) ne renvoient PAS d'email dans le ID Token. La colonne
//     accepte NULL, on l'écrit verbatim — pas de fallback à '' qui
//     casserait l'unicité conditionnelle ou un éventuel CHECK.
//
//   - INSERT renvoie 1 ligne OU THROW : une fédération créée sans
//     ROW visible côté code = un user OIDC sans pointeur fédéré →
//     impossible à retrouver au prochain login → re-création de
//     compte fantôme à chaque login → fuite référentielle.
//
//   - PARAMÈTRE tx HONORÉ : le callback OIDC fait
//     create-user-if-needed + create-federated-identity dans la
//     MÊME transaction. Sans tx partagé, un crash entre les deux
//     laisse soit un user orphelin soit une federated_identity
//     pointant vers un user qui n'existe pas (FK viole) — selon
//     l'ordre des INSERTs.
//
//   - INTERPOLATION PARAMÉTRÉE anti-injection : provider et subject
//     viennent du JWT (claims), donc partiellement attaquant-contrôlés.
//     Les values sont passées séparément des fragments SQL.

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

function makeRow(over: Partial<FederatedIdentityRow> = {}): FederatedIdentityRow {
  return {
    id: 'fi-1',
    userId: 'u-1',
    provider: 'keycloak',
    subject: 'kc-sub-42',
    email: 'alice@example.test',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastLogin: new Date('2026-05-31T12:00:00Z'),
    ...over,
  };
}

describe('FederatedIdentitiesRepository.findByProviderSubject — compound key anti-cross-IdP', () => {
  it('SQL filtre par provider = $ AND subject = $ (compound, pas subject seul)', async () => {
    // CRITIQUE : un attaquant qui contrôle un IdP custom forge un
    // token avec sub=<subject d'un user keycloak>. Sans le filtre
    // provider, le lookup retournerait le user keycloak → impersonation
    // triviale. Lock-in dur des DEUX prédicats.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.findByProviderSubject('keycloak', 'kc-sub-42');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/FROM\s+auth\.federated_identities/i);
    expect(sql).toMatch(/provider\s*=/i);
    expect(sql).toMatch(/subject\s*=/i);
    expect(sql).toMatch(/AND/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
  });

  it('interpole provider PUIS subject (ordre des values, pas inversé)', async () => {
    // Lock anti-régression : un swap silencieux interpolerait
    // subject à la place de provider et le WHERE matcherait toujours
    // (rare mais possible avec des subjects qui ressemblent à des
    // noms de provider).
    const { db, calls } = makeDb([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.findByProviderSubject('keycloak', 'kc-sub-42');
    expect(calls[0]!.values).toEqual(['keycloak', 'kc-sub-42']);
  });

  it('retourne null si aucune fédération (pas undefined, pas throw)', async () => {
    const { db } = makeDb([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    expect(await repo.findByProviderSubject('keycloak', 'inconnu')).toBeNull();
  });

  it('retourne la ligne complète si trouvée', async () => {
    const row = makeRow({ id: 'fi-42' });
    const { db } = makeDb([[row]]);
    const repo = new FederatedIdentitiesRepository(db);
    expect(await repo.findByProviderSubject('keycloak', 'kc-sub-42')).toEqual(row);
  });

  it('subject malicieux ("\'; DROP TABLE…") arrive dans values, JAMAIS dans SQL', async () => {
    // Le subject vient d'un JWT, donc partiellement contrôlable. La
    // tagged template le passe en paramètre lié.
    const { db, calls } = makeDb([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    const malicious = "'; DROP TABLE auth.federated_identities; --";
    await repo.findByProviderSubject('keycloak', malicious);
    expect(calls[0]!.values).toEqual(['keycloak', malicious]);
    expect(sqlOf(calls[0]!)).not.toContain('DROP TABLE');
  });

  it('honore tx (callback OIDC transactionnel)', async () => {
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn, calls: txCalls } = makeTxMock([[makeRow()]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.findByProviderSubject('keycloak', 'kc-sub-42', tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
    expect(txCalls[0]!.values).toEqual(['keycloak', 'kc-sub-42']);
  });
});

describe('FederatedIdentitiesRepository.create', () => {
  it('SQL contient INSERT auth.federated_identities + last_login = now() + RETURNING', async () => {
    // Lock-in du now() à l'INSERT : sans ça, la première session
    // a un last_login NULL → les dashboards ops ne savent pas
    // distinguer "compte créé pas utilisé" de "compte créé puis
    // utilisé".
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.create({
      userId: 'u-1',
      provider: 'keycloak',
      subject: 'kc-sub-42',
      email: 'alice@x',
    });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/INSERT\s+INTO\s+auth\.federated_identities/i);
    expect(sql).toMatch(/last_login\s*\)/i);
    expect(sql).toMatch(/now\(\)/i);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('interpole userId, provider, subject, email dans cet ordre', async () => {
    // Anti-shuffle : un swap silencieux pourrait écrire l'email à
    // la place du userId (les deux sont des strings). Lock l'ordre.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.create({
      userId: 'u-42',
      provider: 'keycloak',
      subject: 'sub-x',
      email: 'bob@x',
    });
    expect(calls[0]!.values).toEqual(['u-42', 'keycloak', 'sub-x', 'bob@x']);
  });

  it('email null est interpolé VERBATIM (anti-fallback "" qui casse l\'unicité)', async () => {
    // CRITIQUE : si on faisait `email ?? ''`, deux users OIDC sans
    // email partageraient l'email '' → CHECK ou unique conditionnel
    // pourrait collisioner. Le NULL est la sémantique correcte.
    const { db, calls } = makeDb([[makeRow({ email: null })]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.create({
      userId: 'u-1',
      provider: 'github',
      subject: 'gh-12',
      email: null,
    });
    expect(calls[0]!.values[3]).toBeNull();
  });

  it('retourne le ROW du RETURNING (id généré côté DB)', async () => {
    const row = makeRow({ id: 'fi-NEW' });
    const { db } = makeDb([[row]]);
    const repo = new FederatedIdentitiesRepository(db);
    const out = await repo.create({
      userId: 'u-1',
      provider: 'keycloak',
      subject: 'sub-x',
      email: 'x@x',
    });
    expect(out).toEqual(row);
  });

  it('THROW si 0 ligne (anti-fédération-fantôme)', async () => {
    // Une fédération créée sans ROW = l'OIDC callback croit avoir
    // lié l'identité mais le prochain login ne la retrouvera pas
    // → re-création de compte fantôme à chaque login.
    const { db } = makeDb([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    await expect(
      repo.create({
        userId: 'u-1',
        provider: 'keycloak',
        subject: 'sub-x',
        email: null,
      }),
    ).rejects.toThrow(/0 ligne/);
  });

  it('honore tx (atomicité user-create + federation-create)', async () => {
    // Sans tx partagé, un crash entre les deux INSERTs (user puis
    // federated_identity) laisse soit un user orphelin (refusant
    // futurs logins parce que pas de federation), soit la FK viole.
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn } = makeTxMock([[makeRow()]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.create(
      {
        userId: 'u-1',
        provider: 'keycloak',
        subject: 'sub-x',
        email: 'x@x',
      },
      tx,
    );
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
  });
});

describe('FederatedIdentitiesRepository.touchLastLogin', () => {
  it('UPDATE last_login = now() WHERE id = $ (interpolation paramétrée)', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.touchLastLogin('fi-42');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/UPDATE\s+auth\.federated_identities/i);
    expect(sql).toMatch(/SET\s+last_login\s*=\s*now\(\)/i);
    expect(sql).toMatch(/WHERE\s+id\s*=/i);
    expect(calls[0]!.values).toEqual(['fi-42']);
  });

  it('honore tx (touch dans le même flow OIDC transactionnel)', async () => {
    const { db, sql: defaultSql } = makeDb();
    const { tx, fn: txFn, calls: txCalls } = makeTxMock([[]]);
    const repo = new FederatedIdentitiesRepository(db);
    await repo.touchLastLogin('fi-42', tx);
    expect(txFn).toHaveBeenCalledTimes(1);
    expect(defaultSql).not.toHaveBeenCalled();
    expect(txCalls[0]!.values).toEqual(['fi-42']);
  });
});
