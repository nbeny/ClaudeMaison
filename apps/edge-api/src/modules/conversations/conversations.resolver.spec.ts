import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AccessTokenClaims } from '../auth/jwt.service';
import { ConversationsResolver, SendMessageResult } from './conversations.resolver';
import type { ConversationsService } from './conversations.service';

// ConversationsResolver est la surface GraphQL des mutations chat. Ses
// invariants critiques :
//
//   - `userId` est TOUJOURS dérivé de `claims.sub` (le JWT), JAMAIS d'un
//     argument GraphQL. Sinon n'importe quel client authentifié pourrait
//     écrire des messages en se faisant passer pour un autre user en
//     manipulant un champ d'input — usurpation d'identité triviale.
//
//   - `workspaceId`, `model`, `conversationId`, `content` sont passés
//     verbatim au service (pas de réécriture silencieuse côté resolver).
//
//   - `sendMessage` renvoie un `SendMessageResult` où `conversationId`
//     est ÉCHO de l'argument du client, pas un champ retourné par le
//     service. Le service retourne uniquement `{userMessageId,
//     assistantMessageId}` — si on dérivait `conversationId` d'un champ
//     de retour fantôme, on aurait silencieusement `undefined` côté wire.
//
//   - Les erreurs du service remontent telles quelles (NotFoundException
//     → 404 côté client) ; pas de swallow ni de fallback silencieux.

const CLAIMS: AccessTokenClaims = { sub: 'u-alice', sid: 'sess-1' };

interface Mocks {
  service: ConversationsService;
  startConversation: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function makeMocks(): Mocks {
  const startConversation = vi.fn();
  const sendMessage = vi.fn();
  const service = { startConversation, sendMessage } as unknown as ConversationsService;
  return { service, startConversation, sendMessage };
}

describe('ConversationsResolver.startConversation', () => {
  it('appelle service.startConversation avec userId = claims.sub (anti-usurpation)', async () => {
    // CRITIQUE : si `userId` venait d'un arg client, n'importe qui
    // pourrait créer des conversations au nom d'autres users. Le JWT
    // (claims.sub) est la SEULE source d'identité légitime.
    const { service, startConversation } = makeMocks();
    startConversation.mockResolvedValue('conv-new');
    const resolver = new ConversationsResolver(service);

    await resolver.startConversation(CLAIMS, 'w-42', 'mistral-7b');

    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(startConversation).toHaveBeenCalledWith({
      workspaceId: 'w-42',
      userId: 'u-alice',
      model: 'mistral-7b',
    });
  });

  it('passe `model` undefined quand non fourni (pas string vide, pas null)', async () => {
    // Important pour le service : `undefined` signifie "utilise le
    // default du workspace", alors que `null` ou `""` pourrait être
    // interprété comme "force-le à vide" → modèle invalide.
    const { service, startConversation } = makeMocks();
    startConversation.mockResolvedValue('conv-x');
    const resolver = new ConversationsResolver(service);

    await resolver.startConversation(CLAIMS, 'w-1');

    const call = startConversation.mock.calls[0]![0] as { model: unknown };
    expect(call.model).toBeUndefined();
  });

  it('retourne tel quel l\'ID renvoyé par le service (pas de transformation)', async () => {
    const { service, startConversation } = makeMocks();
    startConversation.mockResolvedValue('conv-12345');
    const resolver = new ConversationsResolver(service);

    const result = await resolver.startConversation(CLAIMS, 'w-1');

    expect(result).toBe('conv-12345');
  });

  it('propage les erreurs du service (pas de swallow silencieux)', async () => {
    // Sans propagation, l'utilisateur verrait un succès fantôme et un
    // ID de conversation `undefined` → boucle UI infinie.
    const { service, startConversation } = makeMocks();
    startConversation.mockRejectedValue(new Error('db down'));
    const resolver = new ConversationsResolver(service);

    await expect(resolver.startConversation(CLAIMS, 'w-1')).rejects.toThrow('db down');
  });

  it('utilise claims.sub même si claims a un autre sub fourni ailleurs', async () => {
    // Sanity check : on n'a aucun arg `userId` dans la signature, donc
    // pas de risque d'écrasement. On verrouille quand même que claims.sub
    // est bien la source — pas claims.sid ni autre.
    const { service, startConversation } = makeMocks();
    startConversation.mockResolvedValue('c');
    const resolver = new ConversationsResolver(service);
    const claims: AccessTokenClaims = { sub: 'u-real', sid: 's-malicious' };

    await resolver.startConversation(claims, 'w-1');

    expect(startConversation.mock.calls[0]![0]).toMatchObject({ userId: 'u-real' });
  });
});

describe('ConversationsResolver.sendMessage', () => {
  it('appelle service.sendMessage avec userId = claims.sub (anti-usurpation)', async () => {
    // Même invariant que startConversation : sans ça, un client envoie
    // un message au nom d'un autre user en simulant `userId` dans le
    // payload. Le seul `userId` légitime vient du JWT.
    const { service, sendMessage } = makeMocks();
    sendMessage.mockResolvedValue({
      userMessageId: 'mu-1',
      assistantMessageId: 'ma-1',
    });
    const resolver = new ConversationsResolver(service);

    await resolver.sendMessage(CLAIMS, 'conv-1', 'hello');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'u-alice',
      content: 'hello',
    });
  });

  it('retourne conversationId ÉCHO de l\'arg client (pas dérivé du service)', async () => {
    // CRITIQUE : le service retourne `{userMessageId, assistantMessageId}`
    // SANS conversationId. Si l'implémentation tentait de lire
    // `result.conversationId`, on obtiendrait `undefined` sur le wire
    // — le client n'aurait plus de référence à sa conversation et
    // l'UI bouclerait. On lock l'écho explicite.
    const { service, sendMessage } = makeMocks();
    sendMessage.mockResolvedValue({
      userMessageId: 'mu',
      assistantMessageId: 'ma',
    });
    const resolver = new ConversationsResolver(service);

    const out = await resolver.sendMessage(CLAIMS, 'conv-from-client', 'x');

    expect(out.conversationId).toBe('conv-from-client');
  });

  it('retourne userMessageId et assistantMessageId du service verbatim', async () => {
    const { service, sendMessage } = makeMocks();
    sendMessage.mockResolvedValue({
      userMessageId: 'mu-xyz',
      assistantMessageId: 'ma-xyz',
    });
    const resolver = new ConversationsResolver(service);

    const out = await resolver.sendMessage(CLAIMS, 'conv-1', 'x');

    expect(out.userMessageId).toBe('mu-xyz');
    expect(out.assistantMessageId).toBe('ma-xyz');
  });

  it('retourne une instance de SendMessageResult (pour GraphQL field resolution)', async () => {
    // Nest/GraphQL utilise instanceof pour les types de retour. Un
    // plain object pourrait fonctionner aujourd'hui mais casser si
    // SendMessageResult gagne un @ResolveField. Lock l'instance.
    const { service, sendMessage } = makeMocks();
    sendMessage.mockResolvedValue({
      userMessageId: 'mu',
      assistantMessageId: 'ma',
    });
    const resolver = new ConversationsResolver(service);

    const out = await resolver.sendMessage(CLAIMS, 'conv-1', 'x');

    expect(out).toBeInstanceOf(SendMessageResult);
  });

  it('passe `content` verbatim — pas de trim, pas de mutation', async () => {
    // La normalisation appartient au service / au modèle, pas au
    // resolver. Lock-in : le whitespace de bordure est préservé.
    const { service, sendMessage } = makeMocks();
    sendMessage.mockResolvedValue({
      userMessageId: 'mu',
      assistantMessageId: 'ma',
    });
    const resolver = new ConversationsResolver(service);

    await resolver.sendMessage(CLAIMS, 'conv-1', '  hello world  ');

    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      content: '  hello world  ',
    });
  });

  it('propage NotFoundException du service (pas de fallback silencieux)', async () => {
    // Si on swallow le 404, le client reçoit un SendMessageResult
    // fantôme avec des IDs `undefined` et croit que tout va bien.
    const { service, sendMessage } = makeMocks();
    sendMessage.mockRejectedValue(new NotFoundException('conversation not found'));
    const resolver = new ConversationsResolver(service);

    await expect(resolver.sendMessage(CLAIMS, 'conv-ghost', 'x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('propage les erreurs génériques du service', async () => {
    const { service, sendMessage } = makeMocks();
    sendMessage.mockRejectedValue(new Error('db crashed'));
    const resolver = new ConversationsResolver(service);

    await expect(resolver.sendMessage(CLAIMS, 'conv-1', 'x')).rejects.toThrow('db crashed');
  });

  it('n\'appelle PAS le service si on n\'appelle pas le resolver (sanity)', () => {
    // Garde-fou contre un side-effect au constructeur (ex: pré-chargement
    // synchrone). Le service ne doit être touché qu'à la mutation.
    const { service, sendMessage, startConversation } = makeMocks();
    new ConversationsResolver(service);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(startConversation).not.toHaveBeenCalled();
  });
});
