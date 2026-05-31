import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import { SessionsRepository, type SessionRow } from './sessions.repository';

// SessionsRepository stocke les refresh-tokens et porte la détection de
// réutilisation. Invariants critiques (cybersec) :
//
//   - LOOKUP PAR HASH UNIQUEMENT : `findByRefreshHash` interpole le
//     Buffer hash, JAMAIS le plaintext. Si un attaquant lit la DB il
//     ne récupère que des hashes — pas de plaintext token réutilisable.
//
//   - REVOKE IDEMPOTENT : `WHERE revoked_at IS NULL` empêche d'écraser
//     l'horodatage d'une révocation antérieure → l'audit reste exact
//     pour les forensics post-breach (on sait QUAND le token a été
//     révoqué la première fois, pas la dernière).
//
//   - MARK_ROTATED ATOMIQUE : `revoked_at = now()` ET `rotated_to = X`
//     dans le MÊME UPDATE. Sans ça, un crash entre les deux ferait
//     une session "révoquée mais sans pointeur de rotation" → la
//     chaîne `revokeChain` ne pourrait plus la suivre lors d'une
//     détection de réutilisation.
//
//   - REVOKE_CHAIN CTE RÉCURSIVE : on remonte `rotated_to` depuis la
//     session compromise jusqu'à la pointe et on révoque tout, mais
//     seulement les `revoked_at IS NULL` (idem audit). C'est le
//     filet anti-token-stolen : si l'attaquant a déjà fait un refresh,
//     on tue aussi ses nouveaux tokens.
//
//   - NULL-COERCION SUR userAgent/ip : `undefined` est l'absence (cas
//     OIDC ou client sans IP), `null` est explicite. La colonne PG
//     accepte null mais pas undefined → erreur driver. Le `?? null`
//     est la dernière ligne de défense.
//
//   - INSERT renvoie 1 LIGNE OU THROW : un INSERT…RETURNING qui ne
//     rend rien indique une corruption (trigger, ROW-level security
//     qui filtre). Mieux vaut crasher que silencieusement perdre la
//     session — sinon le user a un access-token mais aucune session
//     côté DB → impossible à refresh, et impossible à révoquer.

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

function sqlOf(call: SqlCall): string {
  return call.strings.join('?');
}

const HASH = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');
const HASH_OTHER = Buffer.from('cafebabecafebabecafebabecafebabe', 'hex');
const FUTURE = new Date('2026-12-31T00:00:00Z');

function makeRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    userId: 'u-1',
    expiresAt: FUTURE,
    revokedAt: null,
    rotatedTo: null,
    ...over,
  };
}

describe('SessionsRepository.create', () => {
  it('interpole le BUFFER hash, JAMAIS un plaintext token', async () => {
    // CRITIQUE : la valeur passée au tagged template est `refreshTokenHash`,
    // pas un éventuel `refreshToken` brut. Lock-in : on lit la position
    // dans `values` et on vérifie que c'est bien le Buffer.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toContain(HASH);
    // Aucun champ ressemblant à un plaintext (string aléatoire) ne doit
    // se trouver dans les values — on contrôle qu'il n'y a QUE des
    // valeurs attendues : userId, hash, expiresAt, userAgent, ip.
    expect(calls[0]!.values).toEqual(['u-1', HASH, FUTURE, null, null]);
  });

  it('userAgent undefined → null (la colonne refuse undefined)', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
      userAgent: undefined,
      ip: undefined,
    });
    expect(calls[0]!.values[3]).toBeNull();
    expect(calls[0]!.values[4]).toBeNull();
  });

  it('userAgent null → null (passthrough)', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
      userAgent: null,
      ip: null,
    });
    expect(calls[0]!.values[3]).toBeNull();
    expect(calls[0]!.values[4]).toBeNull();
  });

  it('userAgent "Mozilla/5.0" préservé verbatim (pas de trim ni de truncation)', async () => {
    // Si on truncait, on perdrait l'audit forensique du UA exact qui
    // a établi la session.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
      userAgent: 'Mozilla/5.0',
      ip: '2001:db8::1',
    });
    expect(calls[0]!.values[3]).toBe('Mozilla/5.0');
    expect(calls[0]!.values[4]).toBe('2001:db8::1');
  });

  it('SQL contient INSERT INTO auth.sessions et RETURNING (pas de fallback silencieux)', async () => {
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
    });
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/INSERT\s+INTO\s+auth\.sessions/i);
    expect(sql).toMatch(/RETURNING/i);
  });

  it('retourne la première ligne du RETURNING', async () => {
    const row = makeRow({ id: 'sess-NEW' });
    const { db } = makeDb([[row]]);
    const repo = new SessionsRepository(db);
    const out = await repo.create({
      userId: 'u-1',
      refreshTokenHash: HASH,
      expiresAt: FUTURE,
    });
    expect(out).toEqual(row);
  });

  it('THROW si 0 ligne retournée (anti-session-fantôme)', async () => {
    // Une session côté JWT sans ligne en DB = impossible à révoquer,
    // impossible à refresh. Mieux vaut un 500 visible.
    const { db } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await expect(
      repo.create({
        userId: 'u-1',
        refreshTokenHash: HASH,
        expiresAt: FUTURE,
      }),
    ).rejects.toThrow(/0 ligne/);
  });
});

describe('SessionsRepository.findByRefreshHash', () => {
  it('lookup par hash Buffer, JAMAIS par string plaintext', async () => {
    // CRITIQUE : si quelqu'un changeait la signature pour accepter
    // `string`, le call site enverrait le plaintext et la DB stockerait
    // implicitement un texte cleartext-comparable → fuite triviale.
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.findByRefreshHash(HASH);
    expect(calls[0]!.values).toEqual([HASH]);
  });

  it('retourne null si aucune ligne (pas undefined)', async () => {
    const { db } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    const out = await repo.findByRefreshHash(HASH);
    expect(out).toBeNull();
  });

  it('retourne la première ligne si trouvée', async () => {
    const row = makeRow({ id: 'sess-found' });
    const { db } = makeDb([[row]]);
    const repo = new SessionsRepository(db);
    const out = await repo.findByRefreshHash(HASH);
    expect(out).toEqual(row);
  });

  it('SQL contient WHERE refresh_token_hash = $ et LIMIT 1', async () => {
    // LIMIT 1 protège même si une corruption DB créait des doublons
    // (improbable avec UNIQUE, mais ceinture+bretelles).
    const { db, calls } = makeDb([[makeRow()]]);
    const repo = new SessionsRepository(db);
    await repo.findByRefreshHash(HASH);
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/refresh_token_hash\s*=/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
  });

  it('hash différent → values différentes dans le call (sanity)', async () => {
    // Garde-fou contre un cache mal placé qui ignorerait l'arg.
    const { db, calls } = makeDb([[], []]);
    const repo = new SessionsRepository(db);
    await repo.findByRefreshHash(HASH);
    await repo.findByRefreshHash(HASH_OTHER);
    expect(calls[0]!.values[0]).toBe(HASH);
    expect(calls[1]!.values[0]).toBe(HASH_OTHER);
  });
});

describe('SessionsRepository.findById', () => {
  it('lookup par id, retourne null si absent', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    const out = await repo.findById('sess-missing');
    expect(out).toBeNull();
    expect(calls[0]!.values).toEqual(['sess-missing']);
  });

  it('retourne la ligne trouvée', async () => {
    const row = makeRow({ id: 'sess-x' });
    const { db } = makeDb([[row]]);
    const repo = new SessionsRepository(db);
    expect(await repo.findById('sess-x')).toEqual(row);
  });
});

describe('SessionsRepository.revoke — idempotent', () => {
  it('UPDATE avec WHERE revoked_at IS NULL (anti-écrasement-audit)', async () => {
    // CRITIQUE pour les forensics : si on revoke deux fois, la
    // deuxième révocation NE DOIT PAS écraser l'horodatage de la
    // première. Sinon on perd "QUAND on a su que le token était
    // compromis" → impossible de reconstruire la timeline d'attaque.
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.revoke('sess-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/UPDATE\s+auth\.sessions/i);
    expect(sql).toMatch(/SET\s+revoked_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/revoked_at\s+IS\s+NULL/i);
    expect(calls[0]!.values).toEqual(['sess-1']);
  });
});

describe('SessionsRepository.revokeChain — cascade post-breach', () => {
  it('utilise une CTE RÉCURSIVE qui suit `rotated_to`', async () => {
    // Le CTE récursif est la mécanique anti-token-stolen : si
    // l'attaquant a déjà rafraîchi son token volé, on suit la chaîne
    // de rotation jusqu'à la pointe et on révoque tout. Lock-in du
    // pattern SQL parce qu'un revoke unique laisserait les enfants
    // valides → attaquant garde l'accès.
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.revokeChain('sess-compromised');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/WITH\s+RECURSIVE/i);
    expect(sql).toMatch(/rotated_to/i);
    expect(sql).toMatch(/UNION\s+ALL/i);
  });

  it('ne révoque QUE les `revoked_at IS NULL` (préserve l\'audit antérieur)', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.revokeChain('sess-x');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/revoked_at\s+IS\s+NULL/i);
  });

  it('interpole le startSessionId comme paramètre (anti-injection)', async () => {
    // La tagged template interpole en paramètre lié, jamais en
    // string concat. Lock-in : la value est passée séparément.
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.revokeChain("'; DROP TABLE auth.sessions; --");
    expect(calls[0]!.values).toEqual(["'; DROP TABLE auth.sessions; --"]);
    // La string malicieuse n'apparaît PAS dans les fragments SQL.
    const sql = sqlOf(calls[0]!);
    expect(sql).not.toContain('DROP TABLE');
  });
});

describe('SessionsRepository.markRotated — atomique', () => {
  it('SET revoked_at = now() ET rotated_to = $ dans le MÊME UPDATE', async () => {
    // CRITIQUE : si on faisait deux UPDATE séparés, un crash entre
    // les deux laisserait une session "révoquée sans pointeur" et
    // revokeChain perdrait le maillon. L'atomicité du SQL garantit
    // que les deux colonnes bougent ensemble.
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.markRotated('sess-old', 'sess-new');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/UPDATE\s+auth\.sessions/i);
    expect(sql).toMatch(/SET\s+revoked_at\s*=\s*now\(\)\s*,\s*rotated_to\s*=/is);
    // Un seul UPDATE → un seul call.
    expect(calls).toHaveLength(1);
  });

  it('interpole oldId dans WHERE et newId dans SET (ordre des values)', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.markRotated('sess-old', 'sess-new');
    // Dans la source : SET … rotated_to = ${newId} WHERE id = ${oldId}
    expect(calls[0]!.values).toEqual(['sess-new', 'sess-old']);
  });
});

describe('SessionsRepository.touch', () => {
  it('UPDATE last_used_at = now() WHERE id = $', async () => {
    const { db, calls } = makeDb([[]]);
    const repo = new SessionsRepository(db);
    await repo.touch('sess-1');
    const sql = sqlOf(calls[0]!);
    expect(sql).toMatch(/UPDATE\s+auth\.sessions/i);
    expect(sql).toMatch(/last_used_at\s*=\s*now\(\)/i);
    expect(calls[0]!.values).toEqual(['sess-1']);
  });
});
