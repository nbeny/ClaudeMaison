import { Injectable } from '@nestjs/common';
import { hash, hashSync, verify } from '@node-rs/argon2';

// Paramètres Argon2id alignés sur la recommandation OWASP 2024 :
// 19 MiB memory, 2 iterations, parallelism 1. Suffisant pour résister à
// l'attaque GPU, assez léger pour répondre en <100ms sur un cœur moderne.
// `algorithm: 2` = Argon2id (l'enum natif est `const enum`, incompatible
// avec `isolatedModules: true`, on inline la valeur).
const ARGON2_OPTS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Hash valide d'une chaîne aléatoire, calculé une fois au chargement.
// Sert à uniformiser le coût CPU d'un verify() quand l'utilisateur n'existe
// pas (cf. AuthService.signin) — sans ça, l'attaquant distingue par timing
// « email inconnu » de « mot de passe faux ».
export const DUMMY_HASH = hashSync('dummy-password-for-timing-equalization', ARGON2_OPTS);

@Injectable()
export class PasswordService {
  hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_OPTS);
  }

  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(digest, plaintext);
    } catch {
      // verify() jette si le hash est malformé ; on traite ça comme un échec.
      return false;
    }
  }
}
