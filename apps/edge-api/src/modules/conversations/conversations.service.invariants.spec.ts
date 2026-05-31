import { describe, it, expect, vi } from 'vitest';
import { ConversationsService } from './conversations.service';
import type { AiCoreClient } from './ai-core.client';
import type { ConversationsRepository, ConversationRow } from './conversations.repository';
import type { MessagesRepository, MessageRow } from './messages.repository';

// Caractérisation des invariants subtils de ConversationsService.sendMessage.
//
// conversations.service.spec.ts couvre le happy path (deux appends + touch +
// fire-and-forget) et le NotFound. Ce fichier verrouille les invariants
// silencieux dont la régression ne casserait rien immédiatement mais
// dégraderait subtilement le comportement du chat.
//
//   - **Le placeholder assistant est EXCLU de l'historique envoyé à
//     ai-core** : `history.filter((m) => m.id !== assistantMsg.id)`. Si on
//     enlève ce filter, ai-core voit son propre placeholder vide comme
//     dernière entrée et déraille (peut répondre au vide, ou échouer car
//     une assistant turn sans content précède la prochaine user turn).
//
//   - **History.map ne propage QUE role+content** : pas d'id, pas de
//     tokens, pas de createdAt. Le contrat de fronière ai-core est
//     `{role, content}[]`. Forwarder l'id ferait croire à ai-core que
//     ces objets sont les siens ; forwarder les tokens donnerait des
//     compteurs faux côté usage events.
//
//   - **La mutation retourne AVANT que le fire-and-forget ne se résolve** :
//     `void this.aiCore.triggerTurnStream(...)`. Si on `await`ait, la
//     latence de la mutation deviendrait la latence d'ai-core (potentiel-
//     lement plusieurs secondes), brisant le contrat UX du chat (la
//     réponse de la mutation porte juste les deux IDs ; les tokens
//     arrivent via SSE realtime).
//
//   - **Une erreur ai-core ne fait PAS échouer la mutation** : le
//     `.catch(...)` log mais ne re-throw pas. Sinon, un ai-core down
//     ferait perdre au client les IDs du user+placeholder déjà persistés
//     en base — le client referait son post → duplication.
//
//   - **conv.model est forwardé avec `?? undefined`** (pas `?? null`). Le
//     contrat de bord ai-core attend `model?: string`, JAMAIS `null`.
//     `JSON.stringify({model: null})` produit `"model":null`, que le
//     parseur Pydantic côté ai-core rejette comme type error.
//
//   - **workspaceId vient de conv.workspaceId, PAS de l'input** : la
//     conversation est la source de vérité ; le client ne peut pas
//     glisser un autre workspaceId. Si on prenait input.workspaceId, on
//     aurait potentiellement une mismatch tracking côté billing.
//
//   - **Ordre des opérations** : findById → append(user) → append(assistant)
//     → touchUpdatedAt → listByConversation → triggerTurnStream. Si on
//     inverse touchUpdatedAt et listByConversation, on perd l'idempotence
//     visible ; si on déplace findById après les appends, on insère des
//     messages orphelins en cas de race.

function makeConvRow(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'c1',
    workspaceId: 'w1',
    createdBy: 'u1',
    title: null,
    model: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

function makeMsg(over: Partial<MessageRow>): MessageRow {
  return {
    id: 'm',
    conversationId: 'c1',
    role: 'user',
    content: '',
    finishReason: null,
    tokensIn: null,
    tokensOut: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

interface Harness {
  svc: ConversationsService;
  convRepo: ConversationsRepository;
  msgRepo: MessagesRepository;
  aiCore: AiCoreClient;
  calls: string[];
  append: ReturnType<typeof vi.fn>;
  listByConversation: ReturnType<typeof vi.fn>;
  touchUpdatedAt: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  triggerTurnStream: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
  conv?: ConversationRow | null;
  history?: MessageRow[];
  triggerImpl?: () => Promise<void>;
} = {}): Harness {
  const conv = opts.conv === undefined ? makeConvRow() : opts.conv;
  const userMsg = makeMsg({ id: 'mu', role: 'user', content: 'hi' });
  const assistantMsg = makeMsg({ id: 'ma', role: 'assistant', content: '' });
  const calls: string[] = [];

  const findById = vi.fn(async () => {
    calls.push('findById');
    return conv;
  });
  const touchUpdatedAt = vi.fn(async () => {
    calls.push('touchUpdatedAt');
  });
  const append = vi
    .fn()
    .mockImplementationOnce(async (...args: unknown[]) => {
      calls.push('append:user');
      void args;
      return userMsg;
    })
    .mockImplementationOnce(async (...args: unknown[]) => {
      calls.push('append:assistant');
      void args;
      return assistantMsg;
    });
  const listByConversation = vi.fn(async () => {
    calls.push('listByConversation');
    return opts.history ?? [userMsg, assistantMsg];
  });
  const triggerTurnStream = vi.fn(async () => {
    calls.push('triggerTurnStream');
    if (opts.triggerImpl) await opts.triggerImpl();
  });

  const convRepo = { findById, touchUpdatedAt } as unknown as ConversationsRepository;
  const msgRepo = { append, listByConversation } as unknown as MessagesRepository;
  const aiCore = { triggerTurnStream } as unknown as AiCoreClient;
  return {
    svc: new ConversationsService(convRepo, msgRepo, aiCore),
    convRepo, msgRepo, aiCore,
    calls, append, listByConversation, touchUpdatedAt, findById, triggerTurnStream,
  };
}

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('ConversationsService.sendMessage — invariants subtils', () => {
  describe('Filtrage du placeholder assistant dans l\'historique', () => {
    it('exclut l\'assistantMsg (par id) de l\'historique envoyé à ai-core', async () => {
      // Critique : sans ce filter, ai-core voit son propre placeholder
      // vide. Le comportement d'inférence devient indéfini.
      const h = makeHarness();
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { history: unknown[] };
      expect(call.history).toEqual([{ role: 'user', content: 'hi' }]);
      expect(call.history).toHaveLength(1);
    });

    it('garde TOUS les autres messages, même ceux antérieurs au turn courant', async () => {
      // Le history complet (sauf placeholder) part vers ai-core : turn 1
      // user, turn 1 assistant final, turn 2 user, turn 2 placeholder.
      // ai-core a besoin du contexte complet pour la coherence multi-turn.
      const old1 = makeMsg({ id: 'old-u', role: 'user', content: 'q1' });
      const old2 = makeMsg({ id: 'old-a', role: 'assistant', content: 'r1' });
      const currentUser = makeMsg({ id: 'mu', role: 'user', content: 'hi' });
      const placeholder = makeMsg({ id: 'ma', role: 'assistant', content: '' });
      const h = makeHarness({ history: [old1, old2, currentUser, placeholder] });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { history: unknown[] };
      expect(call.history).toEqual([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'r1' },
        { role: 'user', content: 'hi' },
      ]);
    });
  });

  describe('Forme du payload history', () => {
    it('history.map projete UNIQUEMENT role+content (pas d\'id, tokens, createdAt, finishReason)', async () => {
      // Le contrat de frontière ai-core est strict : {role, content}[].
      // Tout champ supplémentaire serait soit ignoré (waste bande passante)
      // soit causerait une error Pydantic côté Python.
      const userMsg = makeMsg({
        id: 'mu', role: 'user', content: 'hi',
        finishReason: 'stop', tokensIn: 10, tokensOut: 20,
      });
      const placeholder = makeMsg({ id: 'ma', role: 'assistant', content: '' });
      const h = makeHarness({ history: [userMsg, placeholder] });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { history: unknown[] };
      expect(call.history).toEqual([{ role: 'user', content: 'hi' }]);
      // Doublons : aucune fuite des autres champs.
      expect(JSON.stringify(call.history)).not.toContain('mu');
      expect(JSON.stringify(call.history)).not.toContain('tokensIn');
      expect(JSON.stringify(call.history)).not.toContain('createdAt');
      expect(JSON.stringify(call.history)).not.toContain('finishReason');
    });
  });

  describe('Fire-and-forget : la mutation ne wait pas ai-core', () => {
    it('retourne les deux IDs AVANT que triggerTurnStream ne se résolve', async () => {
      // Si on awaitait, la latence du mutation = latence ai-core.
      // Contrat UX : mutation rapide, tokens via SSE realtime ensuite.
      let resolveTrigger: () => void = () => {};
      const pending = new Promise<void>((r) => { resolveTrigger = r; });

      const h = makeHarness({ triggerImpl: () => pending });
      const mutation = h.svc.sendMessage({
        conversationId: 'c1', userId: 'u1', content: 'hi',
      });
      // Au moment où la mutation se résout, triggerTurnStream a été
      // APPELÉ mais PAS encore résolu.
      const result = await mutation;
      expect(result).toEqual({ userMessageId: 'mu', assistantMessageId: 'ma' });
      // La promesse interne est toujours en attente — on n'a pas wait.
      let resolved = false;
      pending.then(() => { resolved = true; });
      await flushMicrotasks();
      expect(resolved).toBe(false);
      // Cleanup.
      resolveTrigger();
      await pending;
    });

    it('une erreur ai-core ne fait PAS échouer la mutation', async () => {
      // .catch() interne sur le triggerTurnStream. Sans ce catch, la
      // promesse non-handled crash le process. Avec le catch, on log + skip.
      const h = makeHarness({
        triggerImpl: async () => { throw new Error('ai-core 500'); },
      });
      // La mutation doit résoudre, pas reject.
      const result = await h.svc.sendMessage({
        conversationId: 'c1', userId: 'u1', content: 'hi',
      });
      expect(result).toEqual({ userMessageId: 'mu', assistantMessageId: 'ma' });
      // L'erreur est swallowed dans le .catch — on flushe pour s'assurer
      // qu'aucun unhandled rejection ne survive.
      await flushMicrotasks();
    });
  });

  describe('Forwarding de conv.model', () => {
    it('conv.model=null → triggerTurnStream reçoit model=undefined (pas null)', async () => {
      // Pydantic ai-core rejette `null` mais accepte `undefined` (absent).
      // L'opérateur `?? undefined` normalise.
      const h = makeHarness({ conv: makeConvRow({ model: null }) });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { model: unknown };
      expect(call.model).toBeUndefined();
      // Et surtout PAS null — sinon JSON.stringify le sérialise comme "model":null.
      expect(call.model).not.toBeNull();
    });

    it('conv.model=string → triggerTurnStream reçoit la string telle quelle', async () => {
      const h = makeHarness({ conv: makeConvRow({ model: 'mistral-small' }) });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { model: unknown };
      expect(call.model).toBe('mistral-small');
    });
  });

  describe('Source de vérité pour workspaceId', () => {
    it('workspaceId vient de conv.workspaceId, jamais d\'un champ d\'input', async () => {
      // Le client ne passe PAS workspaceId à sendMessage. C'est la conv
      // chargée depuis la DB qui en est la source. Cette caractérisation
      // empêche un refactor d'introduire un champ workspaceId en input
      // (qui ouvrirait une voie d'usurpation cross-workspace).
      const h = makeHarness({ conv: makeConvRow({ workspaceId: 'w-real' }) });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { workspaceId: string };
      expect(call.workspaceId).toBe('w-real');
    });
  });

  describe('messageId pointe vers l\'assistant, pas le user', () => {
    it('triggerTurnStream.messageId === assistantMsg.id (le placeholder à remplir)', async () => {
      // Le contrat avec ai-core : "voici l'id du placeholder, complète-le".
      // Si on passait userMsg.id, ai-core écraserait le message user → corruption.
      const h = makeHarness();
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      const call = h.triggerTurnStream.mock.calls[0][0] as { messageId: string };
      expect(call.messageId).toBe('ma');
      expect(call.messageId).not.toBe('mu');
    });
  });

  describe('Ordre des opérations DB', () => {
    it('findById AVANT toute écriture : pas d\'orphelins si la conv n\'existe pas', async () => {
      // Si on appendait avant findById, on aurait des messages
      // orphelins pour des conversations inexistantes (FK violation
      // ou pire, race avec une suppression concurrente).
      const h = makeHarness({ conv: null });
      await expect(
        h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'x' }),
      ).rejects.toThrow('conversation not found');
      expect(h.calls).toEqual(['findById']);
      expect(h.append).not.toHaveBeenCalled();
      expect(h.touchUpdatedAt).not.toHaveBeenCalled();
      expect(h.triggerTurnStream).not.toHaveBeenCalled();
    });

    it('séquence complète : findById → append(user) → append(assistant) → touchUpdatedAt → list → trigger', async () => {
      const h = makeHarness();
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      await flushMicrotasks();
      expect(h.calls).toEqual([
        'findById',
        'append:user',
        'append:assistant',
        'touchUpdatedAt',
        'listByConversation',
        'triggerTurnStream',
      ]);
    });

    it('touchUpdatedAt utilise conv.id (FK), pas input.conversationId', async () => {
      // Subtil : si conv.id différait d'input.conversationId (cas
      // impossible avec un repo correct mais possible si UUID rebinding),
      // c'est la version DB qui prime.
      const h = makeHarness({ conv: makeConvRow({ id: 'c-canonical' }) });
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      expect(h.touchUpdatedAt).toHaveBeenCalledWith('c-canonical');
    });
  });

  describe('Le placeholder assistant a content vide', () => {
    it('le 2e append est appelé avec content=""', async () => {
      // Critique pour l'UX : si on mettait 'thinking...' comme content
      // initial, le client lirait ce texte fantôme avant les vrais tokens.
      // La string vide est le signal "placeholder à remplir via SSE".
      const h = makeHarness();
      await h.svc.sendMessage({ conversationId: 'c1', userId: 'u1', content: 'hi' });
      expect(h.append).toHaveBeenNthCalledWith(2, {
        conversationId: 'c1',
        role: 'assistant',
        content: '',
      });
    });
  });
});

describe('ConversationsService.startConversation — invariants', () => {
  // startConversation est trivial mais sa surface (createdBy, model
  // optionnel) mérite une caractérisation pour éviter qu'un futur refactor
  // ne réécrive silencieusement createdBy depuis un autre champ.

  it('passe createdBy=userId (pas workspaceId, pas un default arbitraire)', async () => {
    // L'utilisateur qui crée est createdBy. La conversation appartient
    // au workspace, mais c'est l'utilisateur qui en est l'auteur.
    const create = vi.fn().mockResolvedValue({ id: 'new-conv' });
    const convRepo = { create } as unknown as ConversationsRepository;
    const msgRepo = {} as unknown as MessagesRepository;
    const aiCore = {} as unknown as AiCoreClient;
    const svc = new ConversationsService(convRepo, msgRepo, aiCore);
    await svc.startConversation({ workspaceId: 'w1', userId: 'u-alice' });
    expect(create).toHaveBeenCalledWith({
      workspaceId: 'w1',
      createdBy: 'u-alice',
      model: undefined,
    });
  });

  it('renvoie row.id (pas l\'objet complet) — contrat scalaire vers le resolver', async () => {
    // Le resolver renvoie un ID GraphQL String, pas la conversation
    // complète. Si on changeait pour renvoyer row, le resolver compilerait
    // mais retournerait `[object Object]` côté wire.
    const create = vi.fn().mockResolvedValue({ id: 'conv-xyz', workspaceId: 'w1' });
    const convRepo = { create } as unknown as ConversationsRepository;
    const svc = new ConversationsService(
      convRepo,
      {} as unknown as MessagesRepository,
      {} as unknown as AiCoreClient,
    );
    const out = await svc.startConversation({ workspaceId: 'w1', userId: 'u1' });
    expect(out).toBe('conv-xyz');
    expect(typeof out).toBe('string');
  });

  it('model optionnel est forwardé tel quel (undefined si absent)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'c' });
    const convRepo = { create } as unknown as ConversationsRepository;
    const svc = new ConversationsService(
      convRepo,
      {} as unknown as MessagesRepository,
      {} as unknown as AiCoreClient,
    );
    await svc.startConversation({ workspaceId: 'w1', userId: 'u1' });
    expect(create.mock.calls[0][0].model).toBeUndefined();

    create.mockClear();
    await svc.startConversation({ workspaceId: 'w1', userId: 'u1', model: 'mistral' });
    expect(create.mock.calls[0][0].model).toBe('mistral');
  });
});
