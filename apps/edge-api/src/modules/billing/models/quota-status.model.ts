import { Field, Float, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class QuotaStatusModel {
  @Field()
  kind!: string;

  @Field()
  allowed!: boolean;

  // null = ressource non-mesurée, -1 = illimité, sinon plafond strict.
  @Field(() => Float, { nullable: true })
  limit?: number | null;

  @Field(() => Float)
  used!: number;

  @Field(() => Float, { nullable: true })
  remaining?: number | null;

  @Field()
  periodStart!: Date;

  @Field()
  periodEnd!: Date;

  @Field()
  planSlug!: string;
}
