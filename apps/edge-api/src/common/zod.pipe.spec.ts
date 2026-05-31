import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod.pipe';

// ZodValidationPipe est utilisée sur TOUTES les mutations GraphQL
// (signup, signin, refresh, logout, futures resolvers...). Une régression
// silencieuse — return `value` (l'input brut) au lieu de `result.data`,
// ou throw `Error` au lieu de `BadRequestException` — aurait des
// conséquences en cascade :
//
//   - return `value` (au lieu de result.data) : les transforms Zod
//     (`.toLowerCase()`, `.trim()`, defaults, refinements) ne sont
//     PAS appliquées. Exemple concret : un user envoie "  Alice@X  "
//     en email, on persiste "  Alice@X  " brut au lieu de "alice@x" →
//     les lookups par email (signin, dedup) deviennent incohérents.
//
//   - throw `Error` (au lieu de BadRequestException) : Nest sérialise
//     en 500 au lieu de 400, l'attaquant ne sait pas que c'est sa
//     faute (pire UX) et le client ne peut pas afficher les erreurs
//     par champ.
//
//   - issues malformées (sans path/message structurés) : le front ne
//     peut pas mettre en surbrillance le champ fautif.
//
// Ces tests verrouillent le contrat des deux directions.

describe('ZodValidationPipe.transform — happy path & transforms', () => {
  it('retourne result.data (transformé) pour un input valide, pas le raw', () => {
    // CRITIQUE : si l'implémentation retournait `value`, les transforms
    // suivantes ne s'appliqueraient pas. On lock-in avec une transform
    // observable (.trim().toLowerCase()).
    const schema = z.object({
      email: z.string().trim().toLowerCase(),
    });
    const pipe = new ZodValidationPipe(schema);
    const out = pipe.transform({ email: '  Alice@Example.com  ' });
    expect(out).toEqual({ email: 'alice@example.com' });
  });

  it('applique les defaults Zod (.default())', () => {
    // Sans `result.data`, les `.default()` ne seraient pas matérialisés
    // et le caller verrait `{name: undefined}` au lieu de `{name: 'guest'}`.
    const schema = z.object({
      name: z.string().default('guest'),
    });
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({})).toEqual({ name: 'guest' });
  });

  it('retourne le primitif pour un schéma scalaire (pas seulement objets)', () => {
    const pipe = new ZodValidationPipe(z.number().int());
    expect(pipe.transform(42)).toBe(42);
  });

  it('coerce via Zod si le schéma le demande (z.coerce.number())', () => {
    // z.coerce.number() transforme la string "42" → number 42.
    // C'est une transform — donc seulement visible via `result.data`.
    const pipe = new ZodValidationPipe(z.coerce.number());
    expect(pipe.transform('42')).toBe(42);
  });
});

describe('ZodValidationPipe.transform — invalide → BadRequestException structurée', () => {
  it('throw BadRequestException (pas Error nu) sur input invalide', () => {
    // Si on throw Error, Nest renvoie 500 et le client ne peut pas
    // distinguer "ta faute" de "notre faute".
    const schema = z.object({ email: z.string().email() });
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ email: 'pas-un-email' })).toThrow(
      BadRequestException,
    );
  });

  it('le response body est {message: "Validation échouée", issues: [...]}', () => {
    const schema = z.object({ email: z.string().email() });
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'oops' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const body = (e as BadRequestException).getResponse() as {
        message: string;
        issues: { path: string; message: string }[];
      };
      expect(body.message).toBe('Validation échouée');
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.issues.length).toBeGreaterThan(0);
    }
  });

  it('chaque issue a {path, message} (pas la forme Zod brute avec code/expected/etc)', () => {
    // Lock-in du format minimal stable. Si on exposait l'objet Zod brut,
    // un changement de version de Zod pourrait casser le contrat client.
    const schema = z.object({ email: z.string().email() });
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'oops' });
      expect.fail('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: Record<string, unknown>[];
      };
      const first = body.issues[0]!;
      expect(Object.keys(first).sort()).toEqual(['message', 'path']);
      expect(typeof first.path).toBe('string');
      expect(typeof first.message).toBe('string');
    }
  });

  it('path imbriqué (["user","email"]) → joint en "user.email"', () => {
    // Sans le join('.'), le front recevrait `path: ["user","email"]`
    // (array) et devrait gérer les deux formats. On lock-in la string
    // dot-notation.
    const schema = z.object({
      user: z.object({ email: z.string().email() }),
    });
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ user: { email: 'oops' } });
      expect.fail('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: { path: string }[];
      };
      expect(body.issues[0]!.path).toBe('user.email');
    }
  });

  it('path racine ([]) → string vide ""', () => {
    // Pour un schéma scalaire qui échoue, Zod produit `path: []`. Le
    // `join('.')` doit donner "" — pas crasher, pas "undefined".
    const pipe = new ZodValidationPipe(z.string().min(5));
    try {
      pipe.transform('hi');
      expect.fail('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: { path: string }[];
      };
      expect(body.issues[0]!.path).toBe('');
    }
  });

  it('plusieurs issues sont TOUTES reportées (pas seulement la première)', () => {
    // Critique pour l'UX : sinon le user corrige email → soumet → "ah
    // aussi password est trop court" → corrige → "ah aussi name est
    // requis"… On reporte tout en un seul aller-retour.
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(12),
      name: z.string().min(1),
    });
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ email: 'oops', password: 'short', name: '' });
      expect.fail('should have thrown');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as {
        issues: { path: string }[];
      };
      const paths = body.issues.map((i) => i.path).sort();
      expect(paths).toEqual(['email', 'name', 'password']);
    }
  });

  it('input null / undefined → BadRequestException (pas crash sur safeParse)', () => {
    const schema = z.object({ email: z.string() });
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform(undefined)).toThrow(BadRequestException);
    expect(() => pipe.transform(null)).toThrow(BadRequestException);
  });
});

describe('ZodValidationPipe — couplage au schéma de constructeur', () => {
  it('chaque instance valide selon SON schéma (pas partagé entre pipes)', () => {
    // Sanity check de la closure : si deux pipes partageaient un état
    // statique, on aurait des fuites entre routes.
    const pipeEmail = new ZodValidationPipe(z.object({ x: z.string().email() }));
    const pipeNumber = new ZodValidationPipe(z.object({ x: z.number() }));

    expect(() => pipeEmail.transform({ x: 'ok@x.fr' })).not.toThrow();
    expect(() => pipeEmail.transform({ x: 42 })).toThrow(BadRequestException);

    expect(() => pipeNumber.transform({ x: 42 })).not.toThrow();
    expect(() => pipeNumber.transform({ x: 'ok@x.fr' })).toThrow(BadRequestException);
  });
});
