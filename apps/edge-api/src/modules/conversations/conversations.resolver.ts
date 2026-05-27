import { Resolver } from '@nestjs/graphql';
import { Conversation } from './models/conversation.model';

@Resolver(() => Conversation)
export class ConversationsResolver {
  // Mutations + queries : Task 16.
}
