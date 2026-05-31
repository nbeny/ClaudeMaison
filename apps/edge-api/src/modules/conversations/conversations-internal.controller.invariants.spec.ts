import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceMembersRepository } from '../auth/workspace-members.repository';
import { ConversationsInternalController } from './conversations-internal.controller';
import type { ConversationsRepository } from './conversations.repository';
import { InternalAuthGuard } from './internal-auth.guard';

// Caractérisation ConversationsInternalController — endpoint UNIQUE consommé
// par realtime pour décider si un user a le droit de s'abonner aux events SSE
// d'une conversation. Les 2 tests happy/sad existants couvrent le contrat
// nominal mais laissent passer plusieurs régressions critiques :
//
//   1. workspaceId DOIT être dérivé du repo (c.workspaceId), JAMAIS d'un
//      input user. Si un PR « optimise » en lisant `query.workspaceId` pour
//      éviter le findById, n'importe quel user peut passer n'importe quel
//      workspace → ACL bypass total.
//   2. Missing conv vs not-member doivent retourner EXACTEMENT la même
//      shape : sinon, un attaquant énumère les conversation IDs existants
//      par comparaison de réponses.
//   3. La classe DOIT porter @UseGuards(InternalAuthGuard) — sinon
//      l'endpoint devient public (anyone peut savoir si user X est dans
//      workspace Y en sniffant les réponses).
//   4. La shape de retour DOIT être strictement {canRead: boolean} — pas
//      de leak de metadata (workspaceId, title, model) qui aiderait à
//      énumérer les workspaces d'un user.
//
// Ces invariants ne se testent pas via la version Nest e2e (trop lourd) ;
// on les vérifie ici par appels directs + introspection de metadata.

type FindByIdReturn = Awaited<ReturnType<ConversationsRepository['findById']>>;

function makeConvRepo(findByIdImpl: () => Promise<FindByIdReturn>) {
  const findById = vi.fn(findByIdImpl);
  return {
    repo: { findById } as unknown as ConversationsRepository,
    findById,
  };
}

function makeMembersRepo(isMemberImpl: () => Promise<boolean>) {
  const isMember = vi.fn(isMemberImpl);
  return {
    repo: { isMember } as unknown as WorkspaceMembersRepository,
    isMember,
  };
}

describe('ConversationsInternalController — canRead=false sur non-membre (gap du spec existant)', () => {
  it('conv existante mais user non-membre → {canRead: false}', async () => {
    // Le spec original ne testait QUE deux cas : membre OK et conv missing.
    // Le scenario « conv existe + user pas membre » n'est pas testé alors
    // que c'est la branche la plus fréquente en prod (un user qui essaie
    // de regarder une conversation d'un autre workspace).
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-target',
      createdBy: 'u-owner',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members, isMember } = makeMembersRepo(async () => false);

    const ctrl = new ConversationsInternalController(conv, members);
    const out = await ctrl.canRead('c-1', 'u-attacker');

    expect(out).toEqual({ canRead: false });
    expect(isMember).toHaveBeenCalledWith('w-target', 'u-attacker');
  });

  it('isMember reçoit exactement (conv.workspaceId, userId) — pas inversion d\'arguments', async () => {
    // Régression possible : un refactor qui inverse `isMember(userId, workspaceId)`
    // ferait que l'ACL teste « workspaceId est membre du userId » — toujours
    // false dans la pratique, mais c'est un faux négatif systémique qui
    // bloquerait tous les flux SSE. Lock l'ordre exact.
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-1',
      createdBy: 'u-x',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members, isMember } = makeMembersRepo(async () => true);

    await new ConversationsInternalController(conv, members).canRead('c-1', 'u-1');

    const [arg0, arg1] = isMember.mock.calls[0]!;
    expect(arg0).toBe('w-1'); // workspaceId d'abord
    expect(arg1).toBe('u-1'); // userId ensuite
    expect(arg0).not.toBe('u-1'); // ne JAMAIS inverser
  });
});

describe('ConversationsInternalController — workspaceId dérivé du conv lookup serveur', () => {
  it('isMember est appelé avec c.workspaceId (la valeur du repo), pas avec une input user', async () => {
    // CRITIQUE sécurité : si quelqu'un « optimise » le code en lisant
    // un workspaceId depuis le query (`@Query('workspaceId')`) pour
    // éviter le findById, un attaquant peut passer n'importe quel
    // workspaceId où IL est membre + un convId qu'il connaît dans un
    // autre workspace → bypass total. On verrouille que la SEULE source
    // de workspaceId est le retour de conv.findById.
    const { repo: conv, findById } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-SECRET-FROM-DB',
      createdBy: 'u-x',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members, isMember } = makeMembersRepo(async () => true);

    await new ConversationsInternalController(conv, members).canRead(
      'c-1',
      'u-1',
    );

    expect(findById).toHaveBeenCalledWith('c-1');
    expect(isMember).toHaveBeenCalledWith('w-SECRET-FROM-DB', 'u-1');
    // Confirme que w-SECRET-FROM-DB vient bien du repo et pas d'ailleurs
    expect(isMember.mock.calls[0]![0]).toBe('w-SECRET-FROM-DB');
  });

  it('même si conv.workspaceId est exotique (UUID-like), il est passé tel quel à isMember', async () => {
    // Pas de transformation/normalisation sournoise du workspaceId entre
    // findById et isMember. Si un .toLowerCase() était introduit, deux
    // workspaces avec UUIDs ne différant que par la casse seraient fusionnés.
    const uuid = '550E8400-E29B-41D4-A716-446655440000';
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: uuid,
      createdBy: 'u-x',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members, isMember } = makeMembersRepo(async () => true);

    await new ConversationsInternalController(conv, members).canRead('c-1', 'u-1');

    expect(isMember.mock.calls[0]![0]).toBe(uuid);
  });
});

describe('ConversationsInternalController — indistinguabilité missing vs non-membre (no info leak)', () => {
  it('missing conv et non-membre retournent EXACTEMENT le même JSON', async () => {
    // Si la réponse différait (ex: `{canRead: false, reason: "missing"}`
    // vs `{canRead: false, reason: "not-member"}`), un attaquant pourrait
    // énumérer les conversation IDs existants par comparaison. Lock
    // l'égalité stricte des réponses.
    const ctrlMissing = new ConversationsInternalController(
      makeConvRepo(async () => null).repo,
      makeMembersRepo(async () => false).repo,
    );
    const ctrlNotMember = new ConversationsInternalController(
      makeConvRepo(async () => ({
        id: 'c-1',
        workspaceId: 'w-1',
        createdBy: 'u-x',
        title: null,
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })).repo,
      makeMembersRepo(async () => false).repo,
    );

    const respMissing = await ctrlMissing.canRead('c-?', 'u-attacker');
    const respNotMember = await ctrlNotMember.canRead('c-1', 'u-attacker');

    expect(JSON.stringify(respMissing)).toBe(JSON.stringify(respNotMember));
  });

  it('missing conv → isMember n\'est PAS appelé (short-circuit pour économiser un round-trip DB)', async () => {
    // Garde-fou perf + sécurité : si un refactor introduisait un appel
    // à isMember avec `workspaceId=undefined` quand conv manque, on
    // exploserait à la DB OU on retournerait true par accident
    // (selon comment EXISTS gère NULL). Le short-circuit `if (!c) return`
    // est non-négociable.
    const { repo: conv } = makeConvRepo(async () => null);
    const { repo: members, isMember } = makeMembersRepo(async () => true);

    const out = await new ConversationsInternalController(conv, members).canRead(
      'inexistant',
      'u-1',
    );

    expect(out).toEqual({ canRead: false });
    expect(isMember).not.toHaveBeenCalled();
  });

  it('findById throw → isMember n\'est PAS appelé (pas de bypass via exception)', async () => {
    // Si findById jette (ex: DB down) et qu'on tombait en fallback sur
    // isMember sans vérifier, on aurait un bypass partiel : la DB membre
    // pourrait être up alors que conversations.conversations est cassée.
    // L'exception doit remonter, point.
    const { repo: conv } = makeConvRepo(async () => {
      throw new Error('DB unreachable');
    });
    const { repo: members, isMember } = makeMembersRepo(async () => true);

    await expect(
      new ConversationsInternalController(conv, members).canRead('c-1', 'u-1'),
    ).rejects.toThrow(/DB unreachable/);
    expect(isMember).not.toHaveBeenCalled();
  });
});

describe('ConversationsInternalController — shape de réponse stricte {canRead: boolean}', () => {
  it('membre OK → réponse a EXACTEMENT 1 clé: canRead', async () => {
    // Si on leakait `{canRead: true, workspaceId, title, model, ...}`,
    // realtime obtiendrait des metadata qu'il ne devrait pas connaître
    // (séparation des concerns). Plus important : un futur attaquant
    // qui compromettrait realtime hériterait de cette fuite.
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-1',
      createdBy: 'u-x',
      title: 'titre secret',
      model: 'gpt-secret',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members } = makeMembersRepo(async () => true);

    const out = await new ConversationsInternalController(conv, members).canRead(
      'c-1',
      'u-1',
    );

    expect(Object.keys(out).sort()).toEqual(['canRead']);
    expect(JSON.stringify(out)).not.toMatch(/titre secret|gpt-secret|w-1/);
  });

  it('valeur canRead est un boolean strict (pas truthy/falsy ni 0/1)', async () => {
    // Le contrat avec HttpConversationAcl côté realtime fait `body.canRead === true`
    // (strict). Si on retournait `canRead: 1` ou `canRead: "yes"`, realtime
    // refuserait silencieusement TOUTES les connexions → DoS silencieux.
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-1',
      createdBy: 'u-x',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members } = makeMembersRepo(async () => true);

    const out = await new ConversationsInternalController(conv, members).canRead(
      'c-1',
      'u-1',
    );

    expect(typeof out.canRead).toBe('boolean');
    expect(out.canRead).toBe(true); // pas 1, pas "true", pas {}
  });

  it('non-membre → réponse a EXACTEMENT 1 clé: canRead (pas de raison qui leak)', async () => {
    const { repo: conv } = makeConvRepo(async () => ({
      id: 'c-1',
      workspaceId: 'w-1',
      createdBy: 'u-x',
      title: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { repo: members } = makeMembersRepo(async () => false);

    const out = await new ConversationsInternalController(conv, members).canRead(
      'c-1',
      'u-1',
    );

    expect(Object.keys(out).sort()).toEqual(['canRead']);
    expect(out.canRead).toBe(false);
  });
});

describe('ConversationsInternalController — ordre d\'appels (findById AVANT isMember, jamais en parallèle)', () => {
  it('findById complète AVANT que isMember démarre', async () => {
    // En parallèle on aurait isMember(undefined, userId) qui ferait du
    // SQL avec un workspace_id NULL → comportement non-déterministe.
    // L'ordre séquentiel est garanti par le `await this.conv.findById(id)`.
    const callOrder: string[] = [];
    const conv = {
      findById: vi.fn(async () => {
        callOrder.push('findById:start');
        await new Promise((r) => setTimeout(r, 5));
        callOrder.push('findById:end');
        return {
          id: 'c-1',
          workspaceId: 'w-1',
          createdBy: 'u-x',
          title: null,
          model: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
    } as unknown as ConversationsRepository;
    const members = {
      isMember: vi.fn(async () => {
        callOrder.push('isMember:start');
        return true;
      }),
    } as unknown as WorkspaceMembersRepository;

    await new ConversationsInternalController(conv, members).canRead('c-1', 'u-1');

    expect(callOrder).toEqual([
      'findById:start',
      'findById:end',
      'isMember:start',
    ]);
  });
});

describe('ConversationsInternalController — InternalAuthGuard appliqué (decorator metadata)', () => {
  it('la classe porte @UseGuards(InternalAuthGuard) — sinon endpoint public', async () => {
    // Si quelqu'un retire le @UseGuards (ex: refactor de modules,
    // « simplification »), TOUS les endpoints internes deviennent
    // accessibles sans secret. Comme c'est un check au boot Nest qui
    // n'apparaît pas dans le code de canRead(), il faut un test
    // dédié à l'introspection de metadata.
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ConversationsInternalController,
    ) as unknown[] | undefined;

    expect(guards).toBeDefined();
    expect(guards).toContain(InternalAuthGuard);
  });

  it('le path classe est exactement "internal/conversations" (contrat realtime)', () => {
    // Realtime hardcode `${EDGE_API_INTERNAL_URL}/internal/conversations/...`.
    // Si on renomme la route ici sans propager côté realtime, TOUS les
    // flux SSE échouent en silence (HttpConversationAcl renvoie false
    // sur 404). Lock le path.
    const path = Reflect.getMetadata(
      PATH_METADATA,
      ConversationsInternalController,
    );
    expect(path).toBe('internal/conversations');
  });

  it('le handler canRead est en GET (idempotent), pas POST', () => {
    // GET = idempotent + caching-friendly. POST changerait la sémantique
    // (action) et casserait l'idée que l'ACL check est sans effet de bord.
    // RequestMethod.GET === 0 dans l'enum @nestjs/common.
    const method = Reflect.getMetadata(
      METHOD_METADATA,
      ConversationsInternalController.prototype.canRead,
    );
    expect(method).toBe(0); // RequestMethod.GET
  });

  it('le sous-path du handler est exactement ":id/can-read"', () => {
    // Contrat avec realtime/HttpConversationAcl : URL =
    // `/internal/conversations/${encodeURIComponent(convId)}/can-read?userId=...`.
    // Toute modif de :id ou de can-read casse l'ACL.
    const path = Reflect.getMetadata(
      PATH_METADATA,
      ConversationsInternalController.prototype.canRead,
    );
    expect(path).toBe(':id/can-read');
  });
});
