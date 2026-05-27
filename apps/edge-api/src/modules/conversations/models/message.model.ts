import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum MessageRole { USER = 'user', ASSISTANT = 'assistant', SYSTEM = 'system', TOOL = 'tool' }
registerEnumType(MessageRole, { name: 'MessageRole' });

@ObjectType()
export class Message {
  @Field(() => ID)
  id!: string;
  @Field(() => ID)
  conversationId!: string;
  @Field(() => MessageRole)
  role!: MessageRole;
  @Field()
  content!: string;
  @Field({ nullable: true })
  finishReason?: string;
  @Field()
  createdAt!: Date;
}
