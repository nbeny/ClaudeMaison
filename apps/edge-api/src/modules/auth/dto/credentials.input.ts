import { Field, InputType } from '@nestjs/graphql';
import { z } from 'zod';

export const CredentialsSchema = z.object({
  email: z.string().email().max(254),
  // Politique minimale : 12 caractères. On ne contraint pas la composition
  // (cf. NIST SP 800-63B) — la longueur prime, et un complexity check
  // énerve plus qu'il ne protège.
  password: z.string().min(12).max(256),
});

@InputType()
export class CredentialsInput {
  @Field()
  email!: string;

  @Field()
  password!: string;
}
