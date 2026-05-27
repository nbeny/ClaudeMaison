import { UseGuards } from '@nestjs/common';
import { Args, Field, ID, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AccessTokenClaims } from '../auth/jwt.service';
import { ConversationsService } from './conversations.service';

@ObjectType()
export class SendMessageResult {
  @Field(() => ID)
  conversationId!: string;
  @Field(() => ID)
  userMessageId!: string;
  @Field(() => ID)
  assistantMessageId!: string;
}

@Resolver()
export class ConversationsResolver {
  constructor(private readonly conversations: ConversationsService) {}

  @Mutation(() => ID)
  @UseGuards(JwtAuthGuard)
  async startConversation(
    @CurrentUser() claims: AccessTokenClaims,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('model', { type: () => String, nullable: true }) model?: string,
  ): Promise<string> {
    return this.conversations.startConversation({
      workspaceId,
      userId: claims.sub,
      model,
    });
  }

  @Mutation(() => SendMessageResult)
  @UseGuards(JwtAuthGuard)
  async sendMessage(
    @CurrentUser() claims: AccessTokenClaims,
    @Args('conversationId', { type: () => ID }) conversationId: string,
    @Args('content') content: string,
  ): Promise<SendMessageResult> {
    const result = await this.conversations.sendMessage({
      conversationId,
      userId: claims.sub,
      content,
    });
    return { conversationId, ...result };
  }
}
