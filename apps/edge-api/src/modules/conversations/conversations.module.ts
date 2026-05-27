import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { AiCoreClient } from './ai-core.client';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsResolver } from './conversations.resolver';
import { ConversationsService } from './conversations.service';
import { MessagesRepository } from './messages.repository';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [
    ConversationsRepository,
    MessagesRepository,
    AiCoreClient,
    ConversationsService,
    ConversationsResolver,
  ],
  exports: [ConversationsService, ConversationsRepository, MessagesRepository],
})
export class ConversationsModule {}
