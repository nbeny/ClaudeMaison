import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Conversation {
  @Field(() => ID)
  id!: string;
  @Field(() => ID)
  workspaceId!: string;
  @Field({ nullable: true })
  title?: string;
  @Field({ nullable: true })
  model?: string;
  @Field()
  createdAt!: Date;
  @Field()
  updatedAt!: Date;
}
