import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class HealthStatus {
  @Field()
  status!: string;

  @Field()
  version!: string;

  @Field({ nullable: true })
  commit?: string;
}
