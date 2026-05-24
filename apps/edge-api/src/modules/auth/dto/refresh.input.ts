import { Field, InputType } from '@nestjs/graphql';
import { z } from 'zod';

export const RefreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

@InputType()
export class RefreshInput {
  @Field()
  refreshToken!: string;
}
