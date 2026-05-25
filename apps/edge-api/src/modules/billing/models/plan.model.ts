import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Plan {
  @Field(() => ID)
  id!: string;

  @Field()
  slug!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  description?: string;

  // Quotas : -1 = illimité, null = ressource non-mesurée.
  @Field(() => Int, { nullable: true })
  quotaLlmTokens?: number | null;

  @Field(() => Int, { nullable: true })
  quotaEmbeddingsTokens?: number | null;

  @Field(() => Int, { nullable: true })
  quotaToolRuns?: number | null;

  @Field(() => Number, { nullable: true })
  quotaStorageGb?: number | null;

  // Exposé en micro-euros pour rester entier et éviter les float-issues côté
  // client ; le formatage humain est à la charge du front.
  @Field(() => Int)
  priceEurMonthMicro!: number;
}
