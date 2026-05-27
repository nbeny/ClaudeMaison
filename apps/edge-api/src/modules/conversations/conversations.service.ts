import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiCoreClient } from './ai-core.client';
import { ConversationsRepository } from './conversations.repository';
import { MessagesRepository } from './messages.repository';

/**
 * Orchestration côté edge-api de la mutation `sendMessage` :
 *   1. persiste le message user,
 *   2. crée un placeholder assistant vide,
 *   3. touche `updated_at` sur la conversation,
 *   4. déclenche ai-core en HTTP fire-and-forget (le streaming réel arrive
 *      côté client via SSE realtime, pas dans cette réponse).
 *
 * La mutation rend la main dès que les deux IDs sont disponibles ; ai-core
 * complétera plus tard le message assistant via NATS → realtime → SSE.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly convRepo: ConversationsRepository,
    private readonly msgRepo: MessagesRepository,
    private readonly aiCore: AiCoreClient,
  ) {}

  async startConversation(input: {
    workspaceId: string;
    userId: string;
    model?: string;
  }): Promise<string> {
    const row = await this.convRepo.create({
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      model: input.model,
    });
    return row.id;
  }

  async sendMessage(input: {
    conversationId: string;
    userId: string;
    content: string;
  }): Promise<{ userMessageId: string; assistantMessageId: string }> {
    const conv = await this.convRepo.findById(input.conversationId);
    if (!conv) throw new NotFoundException('conversation not found');

    const userMsg = await this.msgRepo.append({
      conversationId: conv.id,
      role: 'user',
      content: input.content,
    });
    const assistantMsg = await this.msgRepo.append({
      conversationId: conv.id,
      role: 'assistant',
      content: '',
    });
    await this.convRepo.touchUpdatedAt(conv.id);

    const history = await this.msgRepo.listByConversation(conv.id);
    const historyForAi = history
      .filter((m) => m.id !== assistantMsg.id)
      .map((m) => ({ role: m.role, content: m.content }));

    // Fire-and-forget : on ne `await` pas — la mutation doit rendre la main
    // tout de suite avec les deux IDs. Toute erreur ai-core est loggée mais
    // ne fait pas échouer la mutation (le client le verra via l'absence de
    // tokens SSE, ce sera géré côté UI dans T20).
    void this.aiCore
      .triggerTurnStream({
        conversationId: conv.id,
        workspaceId: conv.workspaceId,
        userId: input.userId,
        messageId: assistantMsg.id,
        model: conv.model ?? undefined,
        history: historyForAi,
      })
      .catch((err: unknown) => {
        this.logger.error(
          'ai-core triggerTurnStream failed',
          err instanceof Error ? err.stack : String(err),
        );
      });

    return { userMessageId: userMsg.id, assistantMessageId: assistantMsg.id };
  }
}
