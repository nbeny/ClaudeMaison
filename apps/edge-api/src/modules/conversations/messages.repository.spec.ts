import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService, SqlConn } from '../../database/database.service';
import { MessagesRepository, type MessageRow } from './messages.repository';

// MessagesRepository tient la table conversations.messages — la mémoire de
// chaque conversation. Trois invariants critiques verrouillés :
//
//   - `listByConversation` ORDER BY created_at ASC : la chronologie est ce
//     qui rend une conversation déchiffrable. ASC inversé en DESC donnerait
//     un re-play à l'envers (l'assistant répond avant que l'user ne demande)
//     et casserait toute reconstruction de contexte pour les retours-arrière
//     ou les exports RGPD. C'est l'invariant anti-désordre.
//
//   - `updateAssistantFinal` ordre des binds (content, finishReason, tokensIn,
//     tokensOut) : tokensIn et tokensOut alimentent la facturation usage
//     côté billing.usage_events. Un swap silencieux entre ces deux compteurs
//     facturerait l'utilisateur sur l'output au prix de l'input (input plus
//     cher que l'output en général ? — non, l'inverse) et inversement —
//     dans les deux cas, on facture le mauvais compteur, ce qui se voit
//     soit comme une fraude, soit comme une fuite de marge.
//
//   - `listByConversation` LIMIT 200 par défaut : sans limite implicite,
//     une conversation de 50 000 tours (pathologique, mais possible avec
//     un bot mal câblé) ferait exploser la mémoire de l'edge-api au
//     chargement. 200 est le plafond Jour-1 ; un override explicite reste
//     possible pour les exports.
//
// Bonus : INSERT minimal (3 colonnes), pas de tokens à l'insert — ils sont
// remplis après le stream LLM via updateAssistantFinal. role enum préservé.

type Call = { strings: TemplateStringsArray; values: unknown[] };

function makeDb(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
  });
  return {
    db: { sql } as unknown as DatabaseService,
    sql,
    calls,
  };
}

function makeTxMock(rowsPerCall: ReadonlyArray<readonly unknown[]>) {
  const calls: Call[] = [];
  let i = 0;
  const tx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rowsPerCall[i++] ?? []);
  }) as unknown as SqlConn;
  return { tx, calls };
}

const sqlOf = (c: Call) => c.strings.join('?');

const USER_MSG: MessageRow = {
  id: 'msg-1',
  conversationId: 'conv-1',
  role: 'user',
  content: 'Bonjour',
  finishReason: null,
  tokensIn: null,
  tokensOut: null,
  createdAt: new Date('2026-05-31T10:00:00Z'),
};

const ASSISTANT_MSG: MessageRow = {
  ...USER_MSG,
  id: 'msg-2',
  role: 'assistant',
  content: 'Bonjour ! Comment puis-je vous aider ?',
  createdAt: new Date('2026-05-31T10:00:01Z'),
};

describe('MessagesRepository', () => {
  describe('append — INSERT 3 colonnes, tokens vides', () => {
    it('retourne la ligne mappée RETURNING', async () => {
      const { db } = makeDb([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      const created = await repo.append({
        conversationId: 'conv-1',
        role: 'user',
        content: 'Bonjour',
      });

      expect(created).toEqual(USER_MSG);
    });

    it('ordre des binds : conversationId, role, content (3 valeurs, pas plus)', async () => {
      const { db, calls } = makeDb([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      await repo.append({
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Réponse',
      });

      expect(calls[0].values).toEqual(['conv-1', 'assistant', 'Réponse']);
      // 3 binds : pas de tokens à l'insert (remplis après stream)
      expect(calls[0].values).toHaveLength(3);
    });

    it('mapping camelCase verrouillé sur 5 colonnes snake', async () => {
      const { db, calls } = makeDb([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      await repo.append({
        conversationId: 'conv-1',
        role: 'user',
        content: 'x',
      });

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/conversation_id\s+AS\s+"conversationId"/i);
      expect(sql).toMatch(/finish_reason\s+AS\s+"finishReason"/i);
      expect(sql).toMatch(/tokens_in\s+AS\s+"tokensIn"/i);
      expect(sql).toMatch(/tokens_out\s+AS\s+"tokensOut"/i);
      expect(sql).toMatch(/created_at\s+AS\s+"createdAt"/i);
    });

    it('role enum passé verbatim (system, tool acceptés)', async () => {
      const { db, calls } = makeDb([[USER_MSG], [USER_MSG]]);
      const repo = new MessagesRepository(db);

      await repo.append({ conversationId: 'c', role: 'system', content: 'x' });
      await repo.append({ conversationId: 'c', role: 'tool', content: 'y' });

      expect(calls[0].values[1]).toBe('system');
      expect(calls[1].values[1]).toBe('tool');
    });

    it("contenu préservé verbatim (anti-trim, anti-escape, anti-NFD)", async () => {
      const { db, calls } = makeDb([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      const tricky = '  Salut\n\nÉté ☀️ 你好  ';
      await repo.append({
        conversationId: 'conv-1',
        role: 'user',
        content: tricky,
      });

      expect(calls[0].values[2]).toBe(tricky);
    });

    it('conversationId en valeur paramétrée (anti-injection)', async () => {
      const { db, calls } = makeDb([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      const malicious = "'; DROP TABLE conversations.messages; --";
      await repo.append({
        conversationId: malicious,
        role: 'user',
        content: 'x',
      });

      expect(calls[0].values[0]).toBe(malicious);
      expect(sqlOf(calls[0])).not.toContain('DROP');
    });

    it('jette quand RETURNING renvoie 0 ligne', async () => {
      const { db } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await expect(
        repo.append({ conversationId: 'c', role: 'user', content: 'x' }),
      ).rejects.toThrow(/INSERT conversations\.messages/);
    });

    it('utilise tx quand fourni (atomicité sendMessage)', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      await repo.append(
        { conversationId: 'c', role: 'user', content: 'x' },
        tx,
      );

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  describe('updateAssistantFinal — ordre tokens VERROUILLÉ (anti-swap billing)', () => {
    it('ordre des binds : content, finishReason, tokensIn, tokensOut, id', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.updateAssistantFinal(
        'msg-2',
        'Réponse finale',
        'stop',
        42, // tokensIn
        77, // tokensOut
      );

      expect(calls[0].values).toEqual([
        'Réponse finale',
        'stop',
        42, // tokensIn AVANT tokensOut, toujours
        77,
        'msg-2',
      ]);
    });

    it('SQL nomme tokens_in puis tokens_out dans cet ordre', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.updateAssistantFinal('m', 'c', 'stop', 1, 2);

      const sql = sqlOf(calls[0]);
      const inIdx = sql.search(/tokens_in/i);
      const outIdx = sql.search(/tokens_out/i);
      expect(inIdx).toBeGreaterThan(-1);
      expect(outIdx).toBeGreaterThan(-1);
      expect(inIdx).toBeLessThan(outIdx);
    });

    it('WHERE id paramétré (anti-injection)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      const malicious = "x'; UPDATE conversations.messages SET content='hacked' WHERE '1'='1";
      await repo.updateAssistantFinal(malicious, 'c', 'stop', 1, 2);

      expect(calls[0].values).toContain(malicious);
      expect(sqlOf(calls[0])).not.toContain('hacked');
    });

    it('tokens à 0 acceptés (réponse vide légitime, ex: stop immédiat)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.updateAssistantFinal('m', '', 'length', 0, 0);

      expect(calls[0].values[2]).toBe(0);
      expect(calls[0].values[3]).toBe(0);
    });

    it('finishReason préservé verbatim (stop, length, content_filter, tool_calls...)', async () => {
      const { db, calls } = makeDb([[], [], []]);
      const repo = new MessagesRepository(db);

      await repo.updateAssistantFinal('m', 'c', 'length', 1, 1);
      await repo.updateAssistantFinal('m', 'c', 'content_filter', 1, 1);
      await repo.updateAssistantFinal('m', 'c', 'tool_calls', 1, 1);

      expect(calls[0].values[1]).toBe('length');
      expect(calls[1].values[1]).toBe('content_filter');
      expect(calls[2].values[1]).toBe('tool_calls');
    });

    it('utilise tx quand fourni', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[]]);
      const repo = new MessagesRepository(db);

      await repo.updateAssistantFinal('m', 'c', 'stop', 1, 2, tx);

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('ne renvoie rien (void)', async () => {
      const { db } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      const result = await repo.updateAssistantFinal('m', 'c', 'stop', 1, 2);

      expect(result).toBeUndefined();
    });
  });

  describe('listByConversation — chronologie ASC + LIMIT 200 défaut', () => {
    it('retourne les rows tels que la DB les renvoie', async () => {
      const { db } = makeDb([[USER_MSG, ASSISTANT_MSG]]);
      const repo = new MessagesRepository(db);

      const rows = await repo.listByConversation('conv-1');

      expect(rows).toEqual([USER_MSG, ASSISTANT_MSG]);
    });

    it('ORDER BY created_at ASC dans le SQL (chronologie naturelle)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.listByConversation('conv-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/ORDER\s+BY\s+created_at\s+ASC/i);
      expect(sql).not.toMatch(/ORDER\s+BY\s+created_at\s+DESC/i);
    });

    it('LIMIT 200 par défaut (anti-fetch-unbounded)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.listByConversation('conv-1');

      // conversationId + limit
      expect(calls[0].values).toEqual(['conv-1', 200]);
    });

    it('limite explicite respectée (override exports)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.listByConversation('conv-1', 50);

      expect(calls[0].values).toEqual(['conv-1', 50]);
    });

    it('conversationId paramétré (anti-injection)', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      const malicious = "' OR conversation_id IS NOT NULL --";
      await repo.listByConversation(malicious);

      expect(calls[0].values[0]).toBe(malicious);
      expect(sqlOf(calls[0])).not.toContain('IS NOT NULL');
    });

    it('mapping camelCase verrouillé sur le SELECT', async () => {
      const { db, calls } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      await repo.listByConversation('conv-1');

      const sql = sqlOf(calls[0]);
      expect(sql).toMatch(/conversation_id\s+AS\s+"conversationId"/i);
      expect(sql).toMatch(/finish_reason\s+AS\s+"finishReason"/i);
      expect(sql).toMatch(/tokens_in\s+AS\s+"tokensIn"/i);
      expect(sql).toMatch(/tokens_out\s+AS\s+"tokensOut"/i);
    });

    it('tableau vide accepté (conversation neuve)', async () => {
      const { db } = makeDb([[]]);
      const repo = new MessagesRepository(db);

      expect(await repo.listByConversation('conv-1')).toEqual([]);
    });

    it('utilise tx quand fourni', async () => {
      const { db } = makeDb([]);
      const { tx, calls } = makeTxMock([[USER_MSG]]);
      const repo = new MessagesRepository(db);

      await repo.listByConversation('conv-1', 200, tx);

      expect(calls).toHaveLength(1);
      expect((db.sql as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
