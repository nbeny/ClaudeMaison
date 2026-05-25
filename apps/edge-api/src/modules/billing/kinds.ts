// Liste close des kinds d'usage acceptés. Doit rester alignée avec :
//   - le CHECK sur billing.usage_events.kind (schema.sql)
//   - les champs quota_<kind> sur billing.plans
//   - la doc côté proto billing.v1
export const USAGE_KINDS = [
  'llm_tokens',
  'embeddings_tokens',
  'tool_runs',
  'storage_gb_day',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export function isUsageKind(value: string): value is UsageKind {
  return (USAGE_KINDS as readonly string[]).includes(value);
}

// Map kind → colonne de quota sur billing.plans. La colonne est `bigint`
// pour les tokens/runs et `numeric` pour storage — on lit en `number` ici
// (les valeurs effectives restent dans la plage représentable pour Jour-1).
export const PLAN_QUOTA_COLUMN: Record<UsageKind, string> = {
  llm_tokens: 'quota_llm_tokens',
  embeddings_tokens: 'quota_embeddings_tokens',
  tool_runs: 'quota_tool_runs',
  storage_gb_day: 'quota_storage_gb',
};
