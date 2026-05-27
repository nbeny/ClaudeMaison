import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';

export interface AiCoreTurnStreamRequest {
  conversationId: string;
  workspaceId: string;
  userId: string;
  messageId: string;
  model?: string;
  history: { role: string; content: string }[];
}

/**
 * Client HTTP fire-and-forget vers ai-core. La mutation `sendMessage` du
 * resolver edge-api persiste les deux messages (user + placeholder assistant)
 * puis appelle ce client pour démarrer le streaming côté Python. Le client
 * attend un 202 Accepted ; tout autre statut est traité comme une erreur,
 * remontée par le caller via `.catch(...)` (le caller ne `await` pas).
 */
@Injectable()
export class AiCoreClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('AI_CORE_URL', { infer: true });
    this.baseUrl = raw.replace(/\/$/, '');
  }

  async triggerTurnStream(req: AiCoreTurnStreamRequest): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/v1/chat/turn/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (resp.status !== 202) {
      throw new Error(`ai-core returned ${resp.status}`);
    }
  }
}
