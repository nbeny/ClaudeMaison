import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Workspace {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  role!: string;
}
