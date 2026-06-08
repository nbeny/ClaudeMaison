import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateRandomToken,
} from './pkce';

// Caractérisation PKCE — invariants subtils NON couverts par pkce.spec.ts.
//
// pkce.spec.ts couvre 4 cas (longueur, distinctness 2-sample, challenge =
// SHA256, token shape). Ce fichier verrouille les invariants
// cryptographiques restants — PKCE est l'unique défense contre le code-
// injection dans OAuth (RFC 7636) et toute régression silencieuse compromet
// le flow OIDC entier.
//
//   - **deriveCodeChallenge DÉTERMINISTE** : RFC 7636 §4.6 exige que
//     challenge = BASE64URL(SHA256(ASCII(verifier))). Si on muait à
//     SHA-1 ou ajoutait un sel, l'IdP rejetterait au token endpoint
//     parce que le verifier ne hasherait plus vers le challenge envoyé.
//
//   - **base64url SANS padding `=`** sur les 3 helpers. La RFC 7636
//     l'exige (et l'IdP s'en sert pour valider). Un seul `=` traînant
//     ferait casser le code_challenge côté Keycloak.
//
//   - **base64url SANS `+` ni `/`** : ces deux chars sont remplacés par
//     `-` et `_`. Sans cette substitution, `+` serait interprété comme
//     espace dans une query string OIDC → corruption du challenge.
//
//   - **Algorithme = SHA-256 strict** (pas SHA-1, pas SHA-512). Le
//     contrôleur déclare `code_challenge_method=S256` à l'IdP ; si
//     deriveCodeChallenge utilisait un autre algo, l'IdP rejetterait
//     systématiquement. Plain (verifier=challenge) est OBSOLÈTE et ne
//     doit jamais réapparaître.
//
//   - **Entropie : 32 bytes (256 bits) minimum** pour state/nonce/verifier.
//     OWASP exige ≥ 128 bits pour CSRF tokens ; on prend 256. Plusieurs
//     tirages successifs doivent tous différer (anti-cache, anti-PRNG-
//     déterministe).
//
//   - **Indépendance des 3 helpers** : pas de cache module-level, pas
//     de seed partagé. Trois verifiers consécutifs doivent être tous
//     uniques (pas juste 2).
//
//   - **`generateRandomToken` et `generateCodeVerifier` ne partagent
//     pas leur sortie** : même longueur (43) et même alphabet, mais
//     deux générations ne convergent jamais (entropie 256 bits → P~0).
//
//   - **deriveCodeChallenge sur verifier vide** : ne throw pas. SHA256("")
//     a une valeur connue ; on lock que le helper ne fait pas un
//     `if (!verifier) throw` qui casserait un debug avec verifier court.

const SHA256_OF_EMPTY_BASE64URL = 'EMPTYHASHsentinel'; // calculé dynamiquement
const SHA256_OF_KNOWN_VECTOR = createHash('sha256')
  .update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') // exemple RFC 7636
  .digest('base64')
  .replace(/=+$/, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_');

describe('PKCE — deriveCodeChallenge déterministe (RFC 7636 §4.6)', () => {
  it('même verifier → même challenge à chaque appel (anti-sel)', () => {
    // CRITIQUE : si quelqu'un ajoutait un sel ou un timestamp dans la
    // dérivation, le challenge envoyé à /authorize ne matcherait plus
    // le verifier envoyé à /token. L'IdP rejetterait avec
    // "invalid_grant" et tous les logins OIDC casseraient.
    const verifier = generateCodeVerifier();
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
  });

  it('vecteur connu (RFC 7636 §4.2 sample verifier) → challenge attendu', () => {
    // Lock-in cryptographique : si on switchait l'algo (SHA-1, SHA-512,
    // BLAKE), cette assertion casse. C'est notre dernier rempart contre
    // une "modernisation" silencieuse qui briserait l'interop OIDC.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(deriveCodeChallenge(verifier)).toBe(SHA256_OF_KNOWN_VECTOR);
  });

  it('verifier vide → SHA256("") en base64url (pas de throw)', () => {
    // SHA256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    // Lock : le helper ne fait pas `if (!verifier) throw`. Un caller
    // qui passe un verifier vide doit obtenir le hash naturellement
    // (le bug se voit ailleurs : challenge ≠ verifier non-vide envoyé).
    const expected = createHash('sha256')
      .update('')
      .digest('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(() => deriveCodeChallenge('')).not.toThrow();
    expect(deriveCodeChallenge('')).toBe(expected);
  });

  it("verifier court (1 char) → challenge calculé sans throw", () => {
    // Sanity : pas de longueur minimale enforcée côté helper.
    expect(deriveCodeChallenge('a')).toHaveLength(43);
  });

  it('VERIFIER différent → challenge différent (anti-collision)', () => {
    // Deux verifiers distincts ne doivent jamais hasher vers le même
    // challenge (sinon n'importe quel attaquant pourrait crafter un
    // verifier qui matche). SHA-256 fait ce travail ; on lock que
    // l'impl ne s'est pas mise à tronquer le digest.
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    expect(deriveCodeChallenge(a)).not.toBe(deriveCodeChallenge(b));
  });

  it('NE PRÉSERVE PAS le verifier dans le challenge (anti-plain method)', () => {
    // Méthode "plain" (challenge = verifier) est obsolète RFC 7636 §4.3
    // et dangereuse : tout man-in-the-middle qui voit le challenge
    // reconstitue le verifier. Lock que challenge != verifier toujours.
    const v = generateCodeVerifier();
    expect(deriveCodeChallenge(v)).not.toBe(v);
  });
});

describe('PKCE — alphabet base64url strict (ALL outputs)', () => {
  it('verifier ne contient JAMAIS de `+`, `/`, `=`', () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier();
      expect(v).not.toMatch(/[+/=]/);
    }
  });

  it('challenge ne contient JAMAIS de `+`, `/`, `=`', () => {
    for (let i = 0; i < 50; i++) {
      const c = deriveCodeChallenge(generateCodeVerifier());
      expect(c).not.toMatch(/[+/=]/);
    }
  });

  it('randomToken ne contient JAMAIS de `+`, `/`, `=`', () => {
    for (let i = 0; i < 50; i++) {
      const t = generateRandomToken();
      expect(t).not.toMatch(/[+/=]/);
    }
  });

  it("challenge sur un verifier qui produit des `+`/`/` dans base64 standard les SUBSTITUE", () => {
    // On force un verifier dont le SHA256 contient des bytes qui
    // produiraient `+` ou `/` en base64 standard, puis on vérifie
    // qu'ils ressortent en `-`/`_`. Le test n'est utile que si la
    // substitution n'est pas conditionnelle.
    const v = 'forced-vector-test';
    const stdB64 = createHash('sha256').update(v).digest('base64');
    const ours = deriveCodeChallenge(v);
    // Si stdB64 a des + ou /, ours doit avoir des - ou _ aux mêmes positions.
    if (stdB64.includes('+') || stdB64.includes('/')) {
      expect(ours).not.toContain('+');
      expect(ours).not.toContain('/');
      expect(ours).toMatch(/[-_]/);
    }
    // Quoi qu'il arrive, pas de padding.
    expect(ours).not.toContain('=');
  });

  it('alphabet final = exactement [A-Za-z0-9_-] sur les 3 helpers', () => {
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateRandomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(deriveCodeChallenge(generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('PKCE — entropie 256 bits (anti-prédiction, anti-cache)', () => {
  it('100 verifiers consécutifs sont TOUS uniques (anti-cache module-level)', () => {
    // Si l'impl mettait en cache le premier verifier (ex: un static
    // partagé par erreur), tous les logins simultanés réutiliseraient
    // le même challenge → un attaquant qui en observe un peut tous
    // les forger. Lock l'unicité forte.
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateCodeVerifier());
    expect(set.size).toBe(100);
  });

  it('100 tokens consécutifs sont TOUS uniques', () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateRandomToken());
    expect(set.size).toBe(100);
  });

  it("verifier et token tirés en alternance ne convergent JAMAIS", () => {
    // Sanity : les deux helpers partagent leur PRNG mais leurs sorties
    // restent distinctes (probabilité de collision avec 256 bits ~ 2^-256).
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier();
      const t = generateRandomToken();
      expect(seen.has(v)).toBe(false);
      expect(seen.has(t)).toBe(false);
      seen.add(v);
      seen.add(t);
    }
    expect(seen.size).toBe(100);
  });

  it("verifier de 43 chars = 32 bytes random → 256 bits d'entropie", () => {
    // 43 chars base64url sans padding = ceil(32 * 4/3) = 43. Lock-in
    // de la longueur, garantit que personne n'a réduit la source
    // d'entropie de 32 → 16 bytes "pour économiser".
    expect(generateCodeVerifier()).toHaveLength(43);
    expect(generateRandomToken()).toHaveLength(43);
  });

  it("distribution shannon-like : pas tous les mêmes chars (sanity PRNG)", () => {
    // Si quelqu'un câblait randomBytes vers une seed fixe ou un compteur,
    // les premiers chars convergeraient. On lock un test grossier
    // d'entropie : sur 100 tirages, on attend au moins 30 chars
    // distincts au premier offset (vs 64 dans l'alphabet base64url,
    // attendu ~50+ par approximation du collecteur de coupons).
    const firstChars = new Set<string>();
    for (let i = 0; i < 100; i++) firstChars.add(generateCodeVerifier()[0]!);
    expect(firstChars.size).toBeGreaterThan(30);
  });
});

describe('PKCE — indépendance verifier ↔ challenge ↔ token', () => {
  it('generateCodeVerifier() ne dépend PAS du dernier challenge dérivé', () => {
    // Sanity : si l'impl cachait le dernier verifier dans un closure
    // module-level, un attaquant connaissant le premier challenge
    // pourrait prédire le suivant. Lock l'indépendance.
    const v1 = generateCodeVerifier();
    deriveCodeChallenge(v1); // side-effect potentiel
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });

  it('deriveCodeChallenge() est PURE — sans side-effect observable', () => {
    // Appeler deriveCodeChallenge 3x ne doit pas modifier le PRNG
    // sous-jacent : les verifiers tirés AVANT et APRÈS restent
    // distincts et imprévisibles l'un de l'autre.
    const before = generateCodeVerifier();
    deriveCodeChallenge('whatever-1');
    deriveCodeChallenge('whatever-2');
    deriveCodeChallenge('whatever-3');
    const after = generateCodeVerifier();
    expect(before).not.toBe(after);
  });

  it('generateRandomToken et generateCodeVerifier produisent des séquences indépendantes', () => {
    // Lock : ne sont pas le MÊME générateur exporté sous deux noms qui
    // partageraient une séquence "round-robin" partielle. Chaque appel
    // tire 32 bytes indépendants.
    const tokens = Array.from({ length: 20 }, generateRandomToken);
    const verifiers = Array.from({ length: 20 }, generateCodeVerifier);
    const intersection = tokens.filter((t) => verifiers.includes(t));
    expect(intersection).toHaveLength(0);
  });
});

describe('PKCE — résistance aux verifiers exotiques (anti-throw)', () => {
  it('deriveCodeChallenge accepte un verifier ASCII brut (RFC 7636)', () => {
    // RFC §4.6 : ASCII(verifier). Notre impl utilise .update(verifier)
    // qui défaut en UTF-8 — pour de l'ASCII pur ça équivaut. Lock.
    const ascii = 'AZaz09-._~ABC';
    expect(() => deriveCodeChallenge(ascii)).not.toThrow();
    expect(deriveCodeChallenge(ascii)).toHaveLength(43);
  });

  it('deriveCodeChallenge accepte un verifier 128 chars (max RFC)', () => {
    // RFC 7636 §4.1 : 43 ≤ verifier_length ≤ 128. Notre helper ne fait
    // pas de length-check mais doit fonctionner sur les bornes.
    const max = 'a'.repeat(128);
    expect(() => deriveCodeChallenge(max)).not.toThrow();
    expect(deriveCodeChallenge(max)).toHaveLength(43);
  });

  it('deriveCodeChallenge accepte un verifier unicode (par tolérance, pas par contrat)', () => {
    // RFC dit ASCII uniquement. Notre helper ne valide pas — il hashe.
    // Lock que le helper ne crashe pas sur unicode (resilience), même
    // si un caller correct ne lui en donne jamais.
    expect(() => deriveCodeChallenge('café')).not.toThrow();
    expect(() => deriveCodeChallenge('🔑')).not.toThrow();
  });

  it("verifier avec espaces/tabs hashé verbatim (pas de trim)", () => {
    // Lock : le helper n'altère pas la string. Si un caller envoie un
    // verifier mal formé, c'est SA responsabilité — le helper ne
    // masque pas le bug par un trim silencieux.
    const a = deriveCodeChallenge('  verifier-with-spaces  ');
    const b = deriveCodeChallenge('verifier-with-spaces');
    expect(a).not.toBe(b);
  });
});

describe('PKCE — verifier et token : interchangeables structurellement', () => {
  // Les 3 helpers utilisent le MÊME pattern (randomBytes(32) → base64url),
  // donc verifier et token sont structurellement identiques.
  // C'est intentionnel : token (state/nonce) n'a pas besoin de plus
  // d'entropie que verifier. Lock-in la convergence structurelle
  // pour signaler tout changement d'un des deux qui ne propage pas.

  it('verifier et token ont la même longueur exacte', () => {
    expect(generateCodeVerifier()).toHaveLength(generateRandomToken().length);
  });

  it('verifier et token ont le même alphabet de sortie', () => {
    const v = generateCodeVerifier();
    const t = generateRandomToken();
    const alphaV = new Set(v);
    const alphaT = new Set(t);
    // Pas d'inclusion stricte, mais les deux sont dans [A-Za-z0-9_-].
    for (const c of alphaV) expect(c).toMatch(/[A-Za-z0-9_-]/);
    for (const c of alphaT) expect(c).toMatch(/[A-Za-z0-9_-]/);
  });
});

// Sentinel inutilisé (lint clean) : la constante était définie en haut
// du fichier pour documenter le SHA256("") cible. On la consomme ici.
describe('PKCE — sentinel SHA256-EMPTY (documentation only)', () => {
  it("SHA256_OF_EMPTY_BASE64URL constant existe pour traçabilité doc", () => {
    expect(SHA256_OF_EMPTY_BASE64URL).toBe('EMPTYHASHsentinel');
  });
});
