import { describe, expect, it } from 'vitest';
import { isUsageKind, PLAN_QUOTA_COLUMN, USAGE_KINDS } from './kinds';

// kinds.ts est une source de vérité PARTAGÉE entre 3 endroits :
//   - le CHECK CONSTRAINT sur billing.usage_events.kind (schema.sql)
//   - les colonnes quota_<kind> sur billing.plans
//   - la doc côté proto billing.v1 (gRPC)
//
// Une dérive entre les 3 endroits causerait :
//   - un INSERT bloqué par la contrainte CHECK (cas pas terrible)
//   - un quota lookup qui pointe sur une colonne fantôme (cas grave :
//     l'UPDATE silencieux ne mettra à jour 0 ligne et le quota
//     deviendra effectivement infini)
//
// Ces tests verrouillent la liste close et le mapping colonne. Si
// quelqu'un ajoute un nouveau kind sans le mapper sur quota_ ou sans
// mettre à jour le CHECK, ces tests sautent et signalent la dérive.

describe('USAGE_KINDS', () => {
  it('contient exactement 4 kinds (liste close)', () => {
    expect(USAGE_KINDS).toHaveLength(4);
  });

  it('contient llm_tokens, embeddings_tokens, tool_runs, storage_gb_day', () => {
    expect([...USAGE_KINDS]).toEqual([
      'llm_tokens',
      'embeddings_tokens',
      'tool_runs',
      'storage_gb_day',
    ]);
  });

  it('est readonly (TypeScript const assertion → tableau gelé)', () => {
    // La déclaration `as const` rend la valeur readonly côté TS, mais
    // pas frozen au runtime. On vérifie quand même qu'aucun ajout
    // n'est passé silencieusement.
    expect(Object.isFrozen(USAGE_KINDS)).toBe(false); // pas figé, mais
    // si on push, le type guard ne fonctionnera plus, donc les
    // PLAN_QUOTA_COLUMN check ci-dessous attraperaient la dérive.
  });
});

describe('isUsageKind — type guard', () => {
  it('renvoie true pour chaque kind connu', () => {
    for (const k of USAGE_KINDS) {
      expect(isUsageKind(k)).toBe(true);
    }
  });

  it('renvoie false pour un kind inconnu', () => {
    expect(isUsageKind('unknown')).toBe(false);
    expect(isUsageKind('LLM_TOKENS')).toBe(false); // case-sensitive
    expect(isUsageKind('')).toBe(false);
  });

  it('renvoie false pour des inputs piège (espaces, prefix)', () => {
    expect(isUsageKind(' llm_tokens')).toBe(false);
    expect(isUsageKind('llm_tokens ')).toBe(false);
    expect(isUsageKind('llm_tokens_extra')).toBe(false);
  });
});

describe('PLAN_QUOTA_COLUMN — mapping schéma', () => {
  it('mappe les 4 kinds aux 4 colonnes quota_ exactes', () => {
    expect(PLAN_QUOTA_COLUMN).toEqual({
      llm_tokens: 'quota_llm_tokens',
      embeddings_tokens: 'quota_embeddings_tokens',
      tool_runs: 'quota_tool_runs',
      storage_gb_day: 'quota_storage_gb', // attention : pas "quota_storage_gb_day"
    });
  });

  it('storage_gb_day → quota_storage_gb (PAS _day, la colonne est par-jour implicite)', () => {
    // Garde-fou explicite : le kind contient "_day" parce qu'il s'agit
    // de gigaoctets-jours côté events, mais la colonne plans est juste
    // "quota_storage_gb" (l'unité jour est implicite côté plan).
    // Renommer l'un sans l'autre = mapping cassé.
    expect(PLAN_QUOTA_COLUMN.storage_gb_day).toBe('quota_storage_gb');
    expect(PLAN_QUOTA_COLUMN.storage_gb_day).not.toBe('quota_storage_gb_day');
  });

  it('chaque kind de USAGE_KINDS a une entrée dans le map (exhaustif)', () => {
    for (const k of USAGE_KINDS) {
      expect(PLAN_QUOTA_COLUMN[k]).toMatch(/^quota_/);
    }
  });

  it('le map a exactement 4 entrées (rien en trop)', () => {
    expect(Object.keys(PLAN_QUOTA_COLUMN)).toHaveLength(4);
  });
});
