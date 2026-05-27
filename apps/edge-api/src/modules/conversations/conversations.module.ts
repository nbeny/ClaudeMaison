import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { AiCoreClient } from './ai-core.client';
import { ConversationsInternalController } from './conversations-internal.controller';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsResolver } from './conversations.resolver';
import { ConversationsService } from './conversations.service';
import { InternalAuthGuard } from './internal-auth.guard';
import { MessagesRepository } from './messages.repository';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ConversationsInternalController],
  providers: [
    ConversationsRepository,
    MessagesRepository,
    AiCoreClient,
    ConversationsService,
    ConversationsResolver,
    InternalAuthGuard,
  ],
  exports: [ConversationsService, ConversationsRepository, MessagesRepository],
})
export class ConversationsModule {}
