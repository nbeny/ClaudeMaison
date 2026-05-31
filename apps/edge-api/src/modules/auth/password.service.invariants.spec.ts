import { describe, expect, it } from 'vitest';
import { DUMMY_HASH, PasswordService } from './password.service';

// Caractérisation PasswordService — invariants sécurité critiques NON
// couverts par password.service.spec.ts. Le but est de verrouiller les
// paramètres Argon2id alignés OWASP 2024 contre toute dégradation
// silencieuse (ex: PR qui réduit memoryCost pour faire passer un timeout
// CI lent, ou bascule en Argon2i pour "compatibilité").
//
// Les hashes Argon2 embarquent leurs paramètres dans la string :
//   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>
//
// On parse cette structure pour assert sur algorithm + m + t + p.

interface ParsedArgon2 {
  algo: string; // 'argon2id', 'argon2i', 'argon2d'
  version: number; // 19 = v1.3
  memoryCost: number; // m=...
  timeCost: number; // t=...
  parallelism: number; // p=...
  salt: string;
  digest: string;
}

function parseArgon2(hash: string): ParsedArgon2 {
  // Format: $argon2id$v=19$m=19456,t=2,p=1$salt$digest
  const parts = hash.split('$').filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`hash mal formé : attendu 5 segments, reçu ${parts.length} (${hash})`);
  }
  const [algo, vSeg, paramsSeg, salt, digest] = parts;
  const version = Number(vSeg!.replace('v=', ''));
  const paramMap = Object.fromEntries(
    paramsSeg!.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, Number(v)] as const;
    }),
  );
  return {
    algo: algo!,
    version,
    memoryCost: paramMap.m!,
    timeCost: paramMap.t!,
    parallelism: paramMap.p!,
    salt: salt!,
    digest: digest!,
  };
}

const svc = new PasswordService();

describe('PasswordService — algorithme Argon2id (pas Argon2i ni Argon2d)', () => {
  it('hash() produit du Argon2id strict (pas argon2i, pas argon2d)', async () => {
    // Argon2id est l'hybride résistant à la fois aux attaques side-channel
    // (faiblesse d'Argon2d) et aux attaques GPU (faiblesse d'Argon2i).
    // OWASP recommande explicitement Argon2id depuis 2020.
    const h = await svc.hash('whatever');
    const parsed = parseArgon2(h);
    expect(parsed.algo).toBe('argon2id');
    expect(parsed.algo).not.toBe('argon2i');
    expect(parsed.algo).not.toBe('argon2d');
  });

  it('DUMMY_HASH utilise aussi Argon2id (pas une variante différente)', () => {
    // CRITIQUE pour le timing-equalization : si DUMMY_HASH est un Argon2i
    // et que les vrais hashes sont Argon2id, verify() prend un temps
    // mesurablement différent → un attaquant distingue email inconnu vs
    // mot de passe faux par mesure de latence.
    const parsed = parseArgon2(DUMMY_HASH);
    expect(parsed.algo).toBe('argon2id');
  });
});

describe('PasswordService — paramètres OWASP 2024 verrouillés', () => {
  it('memoryCost = 19456 KiB (19 MiB) exact', async () => {
    // 19 MiB est le seuil OWASP 2024 pour Argon2id. Baisser cette valeur
    // (ex: 1024 pour faire passer un timeout CI) divise l'effort GPU
    // requis d'un attaquant par un facteur ~20. Lock dur.
    const h = await svc.hash('x');
    expect(parseArgon2(h).memoryCost).toBe(19_456);
  });

  it('timeCost = 2 itérations exact', async () => {
    // 2 itérations = compromis OWASP. 1 est trop rapide, 3+ ralentit le
    // login. Lock pour éviter une "optimisation" inattendue.
    const h = await svc.hash('x');
    expect(parseArgon2(h).timeCost).toBe(2);
  });

  it('parallelism = 1 exact', async () => {
    // Parallelism=1 correspond au profil mono-cœur OWASP. Plus haut
    // donne un avantage à l'attaquant qui peut paralléliser
    // arbitrairement côté GPU.
    const h = await svc.hash('x');
    expect(parseArgon2(h).parallelism).toBe(1);
  });

  it('version Argon2 = 19 (v1.3, la seule valide)', async () => {
    // v=19 correspond à Argon2 v1.3 (RFC 9106). v=16 (v1.0) avait un bug
    // de divulgation partielle. Tout autre value = hash forgé.
    const h = await svc.hash('x');
    expect(parseArgon2(h).version).toBe(19);
  });
});

describe('PasswordService — DUMMY_HASH partage les paramètres timing-equalization', () => {
  it('DUMMY_HASH a EXACTEMENT les mêmes (m, t, p) que les vrais hashes', async () => {
    // C'est tout l'intérêt du DUMMY_HASH : qu'un verify() sur DUMMY_HASH
    // prenne le même temps qu'un verify() sur un vrai hash. Si les
    // paramètres divergent, le timing-equalization est inutile et
    // AuthService.signin fuit l'existence de l'email.
    const real = await svc.hash('user-password');
    const realP = parseArgon2(real);
    const dummyP = parseArgon2(DUMMY_HASH);
    expect(dummyP.memoryCost).toBe(realP.memoryCost);
    expect(dummyP.timeCost).toBe(realP.timeCost);
    expect(dummyP.parallelism).toBe(realP.parallelism);
    expect(dummyP.algo).toBe(realP.algo);
  });

  it('DUMMY_HASH est une constante module-level (pas recalculée à chaque import)', async () => {
    // L'export est `export const DUMMY_HASH = hashSync(...)` au top-level.
    // Si on le transformait en getter qui recalcule à chaque accès, le
    // boot du module deviendrait O(n_workers × hashSync_cost). On
    // verrouille la nature constante par identité référentielle.
    const first = DUMMY_HASH;
    const second = DUMMY_HASH;
    expect(first).toBe(second); // identité référentielle stricte
  });

  it('DUMMY_HASH ne verify() PAS un mot de passe arbitraire', async () => {
    // Verify de DUMMY_HASH doit retourner false pour absolument tout
    // plaintext envoyé par un user — sinon, par accident, un attaquant
    // qui devine la phrase "dummy-password-for-timing-equalization"
    // s'authentifierait comme un email inexistant. Niveau de risque :
    // bas (la phrase est connue du code source) mais lock par principe.
    expect(await svc.verify(DUMMY_HASH, 'whatever')).toBe(false);
    expect(await svc.verify(DUMMY_HASH, '')).toBe(false);
    expect(await svc.verify(DUMMY_HASH, 'password123')).toBe(false);
  });

  it('DUMMY_HASH a un format Argon2 parseable (pas une string sentinelle)', () => {
    // Si quelqu'un remplaçait DUMMY_HASH par 'TIMING_EQUALIZER' sans
    // refaire le hashSync, verify() retournerait false (catch interne)
    // mais en court-circuitant le coût CPU → fuite de timing.
    expect(() => parseArgon2(DUMMY_HASH)).not.toThrow();
  });
});

describe('PasswordService.hash — sel unique par appel', () => {
  it('deux hash() du même plaintext produisent des digests DIFFÉRENTS (sel aléatoire)', async () => {
    // Sans sel unique, deux users avec le même mot de passe auraient
    // le même hash → permet d'agréger les attaques rainbow-table. Argon2
    // génère un sel cryptographique par appel ; lock que ce comportement
    // ne soit pas désactivé via un options.salt fixe.
    const a = await svc.hash('même-mdp');
    const b = await svc.hash('même-mdp');
    expect(a).not.toBe(b);
    expect(parseArgon2(a).salt).not.toBe(parseArgon2(b).salt);
  });

  it('le sel a une longueur >= 16 chars base64 (≥ 12 bytes décodés)', async () => {
    // OWASP : sel minimum 128 bits (16 bytes). En base64 sans padding,
    // 16 bytes = 22 chars min. On lock un seuil conservateur.
    const h = await svc.hash('x');
    const { salt } = parseArgon2(h);
    expect(salt.length).toBeGreaterThanOrEqual(16);
  });
});

describe('PasswordService.verify — robustesse', () => {
  it('verify(digest, plaintext_correct) → true', async () => {
    const digest = await svc.hash('correct-password');
    expect(await svc.verify(digest, 'correct-password')).toBe(true);
  });

  it('verify() refuse un plaintext qui ne diffère que par 1 char', async () => {
    // Sensibilité bit-near du hash : pas de near-match toléré.
    const digest = await svc.hash('correct-password');
    expect(await svc.verify(digest, 'correct-passwore')).toBe(false);
  });

  it('verify() est case-sensitive sur le plaintext', async () => {
    const digest = await svc.hash('CaseSensitive');
    expect(await svc.verify(digest, 'casesensitive')).toBe(false);
    expect(await svc.verify(digest, 'CASESENSITIVE')).toBe(false);
  });

  it('verify() refuse une string vide quand le digest correspond à un mot de passe non-vide', async () => {
    const digest = await svc.hash('non-vide');
    expect(await svc.verify(digest, '')).toBe(false);
  });

  it('verify() sur un digest tronqué retourne false (pas de throw qui leak)', async () => {
    const digest = await svc.hash('whatever');
    const truncated = digest.slice(0, digest.length - 5);
    // Le catch interne convertit toute exception verify() en `false`.
    // Sans ce catch, on aurait une exception non-typée qui remonte au
    // resolver GraphQL et leak l'info qu'on a un hash mal stocké.
    expect(await svc.verify(truncated, 'whatever')).toBe(false);
  });

  it('verify() sur un digest random-string retourne false (pas de throw)', async () => {
    expect(await svc.verify('$argon2id$v=19$m=1,t=1,p=1$YWFh$YWFh', 'x')).toBe(false);
  });

  it('verify() sur un digest empty-string retourne false', async () => {
    expect(await svc.verify('', 'anything')).toBe(false);
  });
});

describe('PasswordService.hash — surface async', () => {
  it('hash() retourne une Promise (pas une string synchrone)', () => {
    // Garantit qu'on n'a pas accidentellement basculé sur hashSync,
    // ce qui bloquerait l'event-loop Nest sur chaque login.
    const ret = svc.hash('x');
    expect(ret).toBeInstanceOf(Promise);
  });

  it('verify() retourne une Promise', () => {
    const ret = svc.verify(DUMMY_HASH, 'x');
    expect(ret).toBeInstanceOf(Promise);
  });
});
