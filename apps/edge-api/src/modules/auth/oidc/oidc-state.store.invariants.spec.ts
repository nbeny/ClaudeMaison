import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../../redis/redis.service';
import { OidcStateStore, type OidcStateData } from './oidc-state.store';

// Caractérisation OidcStateStore — invariants sécurité-critiques NON
// couverts par oidc-state.store.spec.ts.
//
// Ce store conserve les données nécessaires entre /login et /callback
// (codeVerifier PKCE, nonce ID-token, returnTo). Une régression silencieuse
// ouvre des trous CSRF / replay :
//
//   - **KEY_PREFIX = `oidc:state:`** : si quelqu'un changeait en `state:`,
//     une collision avec d'autres modules (sessions, password reset)
//     deviendrait possible et la sémantique GETDEL casserait la state
//     machine.
//
//   - **GETDEL atomique = one-shot strict** : deux consume() concurrents
//     sur le même state DOIVENT donner data + null, jamais data + data.
//     C'est l'anti-replay : un attaquant qui intercepte le callback ne
//     peut pas le rejouer.
//
//   - **JSON corrompu en Redis → null, PAS throw** : volontaire — sinon
//     un attaquant qui contamine Redis (ou un opérateur qui fait `redis-cli
//     SET oidc:state:X garbage`) ferait crasher le callback OIDC. On
//     préfère que le callback échoue proprement avec "state invalid".
//
//   - **TTL = 600s exactement** : 10 min est le compromis. Si quelqu'un
//     bumpait à 86400, la fenêtre d'attaque s'étendrait.
//
//   - **`result !== 'OK'`** : Redis renvoie `'OK'` sur succès, `null` sur
//     NX-rejected. Si on écrivait `if (!result)`, un retour `null` ferait
//     `if (!null) === if (true)` → throw OK. Mais une string vide ou un
//     `0` ferait passer → silently écraser. Le test verrouille la
//     comparaison stricte.
//
//   - **returnTo optionnel** : `JSON.stringify({returnTo: undefined})`
//     élide la clé, donc le restore récupère `{returnTo: undefined}` qui
//     se sérialise en équivalent. Cas réel : login sans deep-link.
//
//   - **State arbitraire** : caractères URL-safe (base64url), pas de
//     normalisation. Le caller (PKCE.generateState) produit du base64url
//     mais le store ne doit pas faire d'hypothèse.

class FakeRedis {
  store = new Map<string, string>();

  set = vi.fn(
    async (key: string, value: string, _ex: 'EX', _ttl: number, _nx: 'NX') => {
      if (this.store.has(key)) return null;
      this.store.set(key, value);
      return 'OK';
    },
  );

  getdel = vi.fn(async (key: string) => {
    const v = this.store.get(key);
    if (v === undefined) return null;
    this.store.delete(key);
    return v;
  });
}

function makeStore(): { store: OidcStateStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  const store = new OidcStateStore({ client: redis } as unknown as RedisService);
  return { store, redis };
}

const SAMPLE: OidcStateData = {
  codeVerifier: 'v'.repeat(43), // longueur PKCE minimale RFC 7636
  nonce: 'n'.repeat(32),
  returnTo: 'http://localhost:3001/after',
  createdAt: 1_700_000_000_000,
};

describe('OidcStateStore — KEY_PREFIX namespace isolation', () => {
  it('préfixe la clé Redis avec exactement `oidc:state:` (pas d\'autre namespace)', async () => {
    const { store, redis } = makeStore();
    await store.put('abc', SAMPLE);
    const calls = redis.set.mock.calls[0]!;
    expect(calls[0]).toBe('oidc:state:abc');
    // Anti-régression : si on dropait le `oidc:`, on aurait
    // collisionnable avec d'autres états (sessions, password reset).
    expect(calls[0]).toMatch(/^oidc:state:/);
  });

  it('consume utilise le MÊME préfixe que put (sinon round-trip casse)', async () => {
    const { store, redis } = makeStore();
    await store.put('xyz', SAMPLE);
    await store.consume('xyz');
    expect(redis.getdel).toHaveBeenCalledWith('oidc:state:xyz');
  });
});

describe('OidcStateStore — atomicité one-shot (anti-replay)', () => {
  it('utilise GETDEL (atomique) et pas GET puis DEL séparés', async () => {
    // CRITIQUE : un GET puis DEL non-atomique laisse une fenêtre où
    // deux consume() concurrents lisent le même state — replay possible.
    const { store, redis } = makeStore();
    await store.put('s', SAMPLE);
    await store.consume('s');
    expect(redis.getdel).toHaveBeenCalledOnce();
  });

  it('après consume, la clé est supprimée de Redis (vérifiable côté backend)', async () => {
    const { store, redis } = makeStore();
    await store.put('s', SAMPLE);
    await store.consume('s');
    expect(redis.store.has('oidc:state:s')).toBe(false);
  });

  it('deux consume() séquentiels : 1er = data, 2e = null (one-shot strict)', async () => {
    const { store } = makeStore();
    await store.put('s', SAMPLE);
    const a = await store.consume('s');
    const b = await store.consume('s');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});

describe('OidcStateStore.put — sémantique SET NX EX', () => {
  it('passe EX=600 secondes (10 minutes) — pas plus, pas moins', async () => {
    // 10 minutes est le compromis utilisateur réel : un user qui n'a pas
    // validé Keycloak en 10 min doit recommencer. Un bump à 86400 (24h)
    // étendrait dangereusement la fenêtre d'attaque CSRF.
    const { store, redis } = makeStore();
    await store.put('s', SAMPLE);
    const call = redis.set.mock.calls[0]!;
    expect(call[2]).toBe('EX');
    expect(call[3]).toBe(600);
  });

  it('passe le flag NX (set-if-not-exists)', async () => {
    // Sans NX, deux put() concurrents pour le même state écraseraient
    // silencieusement — bug invisible mais corrompt la state machine.
    const { store, redis } = makeStore();
    await store.put('s', SAMPLE);
    const call = redis.set.mock.calls[0]!;
    expect(call[4]).toBe('NX');
  });

  it('throw quand result n\'est pas EXACTEMENT la string "OK" (test result === "OK")', async () => {
    // Si on remplaçait `result !== 'OK'` par `!result`, un retour
    // truthy non-OK (Redis bug improbable mais possible avec un cluster
    // qui retourne un autre wire format) passerait silencieusement.
    const redis = {
      set: vi.fn().mockResolvedValue('NOT-OK'),
      getdel: vi.fn(),
    };
    const store = new OidcStateStore({ client: redis } as unknown as RedisService);
    await expect(store.put('s', SAMPLE)).rejects.toThrow(/Collision/);
  });

  it('throw quand result est `null` (NX-rejected = collision réelle)', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null),
      getdel: vi.fn(),
    };
    const store = new OidcStateStore({ client: redis } as unknown as RedisService);
    await expect(store.put('s', SAMPLE)).rejects.toThrow(/Collision/);
  });

  it('sérialise le payload en JSON parseable (pas un Buffer / pas un objet brut)', async () => {
    const { store, redis } = makeStore();
    await store.put('s', SAMPLE);
    const payload = redis.set.mock.calls[0]![1]!;
    expect(typeof payload).toBe('string');
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(JSON.parse(payload)).toEqual(SAMPLE);
  });
});

describe('OidcStateStore.consume — robustesse à la corruption', () => {
  it('JSON corrompu en Redis → retourne null, PAS throw', async () => {
    // CRITIQUE : si on throw, un opérateur qui fait
    // `redis-cli SET oidc:state:X garbage` (ou un attaquant qui
    // contamine Redis via une autre vuln) ferait crasher le callback
    // OIDC avec un 500 — pire UX qu'un "state invalide" propre.
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      getdel: vi.fn().mockResolvedValue('this is not json {{{ }}}'),
    };
    const store = new OidcStateStore({ client: redis } as unknown as RedisService);
    const result = await store.consume('s');
    expect(result).toBeNull();
  });

  it('JSON vide ("") → null (pas exception)', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      getdel: vi.fn().mockResolvedValue(''), // empty string is falsy
    };
    const store = new OidcStateStore({ client: redis } as unknown as RedisService);
    expect(await store.consume('s')).toBeNull();
  });

  it('null direct de Redis (clé absente) → null', async () => {
    const { store } = makeStore();
    expect(await store.consume('never-put')).toBeNull();
  });

  it('JSON valide mais structure imprévue → retourne tel quel (pas de schéma runtime)', async () => {
    // Le store ne valide pas le schéma — c'est le caller (OidcController)
    // qui s'en charge. Verrouille l'absence de validation ici (pour ne
    // pas dupliquer la logique).
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      getdel: vi.fn().mockResolvedValue('{"unexpected":"shape"}'),
    };
    const store = new OidcStateStore({ client: redis } as unknown as RedisService);
    const result = await store.consume('s');
    expect(result).toEqual({ unexpected: 'shape' });
  });
});

describe('OidcStateStore — round-trip fidélité des champs', () => {
  it('round-trip d\'un payload sans returnTo (login direct, pas deep-link)', async () => {
    const { store } = makeStore();
    const noReturnTo: OidcStateData = {
      codeVerifier: 'v'.repeat(43),
      nonce: 'n'.repeat(32),
      createdAt: 1_700_000_000_000,
    };
    await store.put('s', noReturnTo);
    const restored = await store.consume('s');
    expect(restored?.codeVerifier).toBe(noReturnTo.codeVerifier);
    expect(restored?.nonce).toBe(noReturnTo.nonce);
    expect(restored?.createdAt).toBe(noReturnTo.createdAt);
    expect(restored?.returnTo).toBeUndefined();
  });

  it('round-trip préserve EXACTEMENT codeVerifier (anti-base64url mangling)', async () => {
    // codeVerifier PKCE = base64url, contient `-` `_` qui sont URL-safe
    // mais qui peuvent être mal handled si on faisait du URL encoding.
    const { store } = makeStore();
    const tricky: OidcStateData = {
      codeVerifier: 'abc-DEF_ghi-JKL_mno-PQR_stu-VWX_yz0-123_456-789_ABC-DEF_g',
      nonce: 'nonce',
      createdAt: 0,
    };
    await store.put('s', tricky);
    const restored = await store.consume('s');
    expect(restored?.codeVerifier).toBe(tricky.codeVerifier);
  });

  it('round-trip préserve createdAt en number (pas converti en string par JSON)', async () => {
    // Sanity : JSON.stringify(number) → number string, JSON.parse → number.
    // Si quelqu'un encodait en `String(createdAt)`, on perdrait le type.
    const { store } = makeStore();
    await store.put('s', SAMPLE);
    const restored = await store.consume('s');
    expect(typeof restored?.createdAt).toBe('number');
    expect(restored?.createdAt).toBe(SAMPLE.createdAt);
  });

  it('round-trip d\'un state contenant des caractères spéciaux URL-safe', async () => {
    // Le state lui-même est généré par PKCE (base64url). Le store ne
    // doit pas le restreindre — on prend brut.
    const { store } = makeStore();
    const trickyState = 'aA0-_~';
    await store.put(trickyState, SAMPLE);
    expect(await store.consume(trickyState)).toEqual(SAMPLE);
  });
});

describe('OidcStateStore — collision detection (NX strict)', () => {
  it('un second put sur le MÊME state → throw (pas écrasement silencieux)', async () => {
    const { store } = makeStore();
    await store.put('s', SAMPLE);
    await expect(store.put('s', { ...SAMPLE, nonce: 'autre' })).rejects.toThrow(
      /Collision/,
    );
  });

  it('après échec de put, le payload original est PRÉSERVÉ (pas corrompu)', async () => {
    // Vérouillage NX : un put en collision ne doit pas toucher le payload
    // existant. Sinon, un attaquant pourrait écraser un state légitime
    // (DoS sur le login en cours).
    const { store } = makeStore();
    await store.put('s', SAMPLE);
    const attacker = { ...SAMPLE, codeVerifier: 'attacker-controlled' };
    await expect(store.put('s', attacker)).rejects.toThrow();
    const restored = await store.consume('s');
    expect(restored?.codeVerifier).toBe(SAMPLE.codeVerifier);
  });
});

describe('OidcStateStore — état après consume (clé droppée)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('après consume, un put avec le même state RÉUSSIT (slot libéré)', async () => {
    // Sanity : consume libère le slot NX, sinon on perdrait l'usage
    // d'un state donné après un seul callback (rare mais légitime
    // pour un re-login immédiat).
    const { store } = makeStore();
    await store.put('s', SAMPLE);
    await store.consume('s');
    await expect(store.put('s', SAMPLE)).resolves.toBeUndefined();
  });
});
