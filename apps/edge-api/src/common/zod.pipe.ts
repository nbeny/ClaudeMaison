import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Pipe paramétrée par un schéma Zod. À utiliser comme :
 *   `@Args('input', new ZodValidationPipe(MySchema)) input: MyInput`
 *
 * On garde le type GraphQL généré comme contrat externe (utile pour
 * l'introspection et le SDK), et on valide en plus avec Zod parce que les
 * `@InputType` n'expriment pas les contraintes (longueur, format email…).
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new BadRequestException({ message: 'Validation échouée', issues });
    }
    return result.data;
  }
}
