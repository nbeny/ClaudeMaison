import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { WorkspaceMembersRepository } from '../auth/workspace-members.repository';
import { ConversationsRepository } from './conversations.repository';
import { InternalAuthGuard } from './internal-auth.guard';

/**
 * Endpoints internes service-à-service. Protégés par `InternalAuthGuard`
 * (header `x-internal-secret`). Le seul caller Jour-1 est realtime, qui
 * vérifie l'ACL d'une conversation avant d'ouvrir un flux SSE.
 */
@Controller('internal/conversations')
@UseGuards(InternalAuthGuard)
export class ConversationsInternalController {
  constructor(
    private readonly conv: ConversationsRepository,
    private readonly members: WorkspaceMembersRepository,
  ) {}

  @Get(':id/can-read')
  async canRead(
    @Param('id') id: string,
    @Query('userId') userId: string,
  ): Promise<{ canRead: boolean }> {
    const c = await this.conv.findById(id);
    if (!c) return { canRead: false };
    const ok = await this.members.isMember(c.workspaceId, userId);
    return { canRead: ok };
  }
}
