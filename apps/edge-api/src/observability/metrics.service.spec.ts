import { beforeEach, describe, expect, it, vi } from 'vitest';

// On mocke @opentelemetry/api avant l'import du SUT : le constructeur de
// MetricsService crée 3 counters via `metrics.getMeter('edge-api').createCounter`,
// donc le mock doit être prêt. Chaque counter est une instance vi.fn() qu'on
// inspecte ensuite via les .mock.calls.

interface CounterCalls {
  add: ReturnType<typeof vi.fn>;
}
type CountersByName = Map<string, CounterCalls>;

const counters: CountersByName = new Map();

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: vi.fn(() => ({
      createCounter: vi.fn((name: string) => {
        const counter = { add: vi.fn() };
        counters.set(name, counter);
        return counter;
      }),
    })),
  },
}));

import { MetricsService } from './metrics.service';

// MetricsService est la façade OTel pour 3 counters :
//   - auth_attempts_total (kind, result)
//   - billing_quota_check_total (kind, allowed)
//   - billing_usage_events_recorded_total (result: 'accepted'|'duplicate')
//
// Invariants critiques verrouillés :
//
//   - recordUsageEvents anti-zero-noise : sans le guard `> 0`, on
//     ajouterait un counter à 0 pour 'accepted' ou 'duplicate' à chaque
//     appel, ce qui polluerait les séries Prometheus avec des points à 0
//     et ferait monter la cardinalité « duplicate » sur des appels qui
//     n'en ont jamais eu. Le pattern est : on n'instancie un point
//     temporel QUE si la valeur est non-nulle.
//
//   - recordQuotaCheck `String(allowed)` : OTel API accepte les booleans
//     en attribut, mais on sérialise en `'true'/'false'` parce que la
//     stack Prom/Grafana indexe les labels en string. Sans la
//     sérialisation, Prom voit le label comme `true` puis `1` selon
//     l'exporter et casse les agrégations.
//
//   - recordAuthAttempt : les tags sont kind ET result, pas l'un OU
//     l'autre. Un oubli laisserait toutes les attempts dans un même
//     bucket sans pouvoir distinguer success/failure.

describe('MetricsService', () => {
  beforeEach(() => {
    counters.clear();
  });

  describe('recordAuthAttempt', () => {
    it('incrémente auth_attempts_total avec tags {kind, result}', () => {
      const svc = new MetricsService();

      svc.recordAuthAttempt('signin', 'success');

      const add = counters.get('auth_attempts_total')!.add;
      expect(add).toHaveBeenCalledWith(1, { kind: 'signin', result: 'success' });
    });

    it('compte chaque appel comme +1', () => {
      const svc = new MetricsService();

      svc.recordAuthAttempt('signup', 'success');
      svc.recordAuthAttempt('signup', 'failure');
      svc.recordAuthAttempt('refresh', 'success');

      const add = counters.get('auth_attempts_total')!.add;
      expect(add).toHaveBeenCalledTimes(3);
      expect(add).toHaveBeenNthCalledWith(1, 1, { kind: 'signup', result: 'success' });
      expect(add).toHaveBeenNthCalledWith(2, 1, { kind: 'signup', result: 'failure' });
      expect(add).toHaveBeenNthCalledWith(3, 1, { kind: 'refresh', result: 'success' });
    });

    it('couvre les 5 kinds (signup/signin/refresh/logout/oidc)', () => {
      const svc = new MetricsService();
      const kinds = ['signup', 'signin', 'refresh', 'logout', 'oidc'] as const;

      for (const k of kinds) svc.recordAuthAttempt(k, 'success');

      const add = counters.get('auth_attempts_total')!.add;
      const observedKinds = add.mock.calls.map((c) => (c[1] as { kind: string }).kind);
      expect(observedKinds).toEqual([...kinds]);
    });
  });

  describe('recordQuotaCheck', () => {
    it('incrémente billing_quota_check_total avec allowed sérialisé en string', () => {
      const svc = new MetricsService();

      svc.recordQuotaCheck('llm_tokens', true);

      const add = counters.get('billing_quota_check_total')!.add;
      expect(add).toHaveBeenCalledWith(1, { kind: 'llm_tokens', allowed: 'true' });
    });

    it('allowed false → "false" (string, pas boolean)', () => {
      const svc = new MetricsService();

      svc.recordQuotaCheck('storage_gb_day', false);

      const add = counters.get('billing_quota_check_total')!.add;
      expect(add).toHaveBeenCalledWith(1, { kind: 'storage_gb_day', allowed: 'false' });
      // Type narrowing : pas un boolean dans le payload final
      const call = add.mock.calls[0]!;
      expect(typeof (call[1] as { allowed: unknown }).allowed).toBe('string');
    });

    it('+1 par appel, accumule', () => {
      const svc = new MetricsService();

      svc.recordQuotaCheck('tool_runs', true);
      svc.recordQuotaCheck('tool_runs', false);

      const add = counters.get('billing_quota_check_total')!.add;
      expect(add).toHaveBeenCalledTimes(2);
    });
  });

  describe('recordUsageEvents — anti-zero-noise', () => {
    it('accepted > 0 et duplicates > 0 → 2 points avec leurs tags', () => {
      const svc = new MetricsService();

      svc.recordUsageEvents(5, 2);

      const add = counters.get('billing_usage_events_recorded_total')!.add;
      expect(add).toHaveBeenCalledTimes(2);
      expect(add).toHaveBeenCalledWith(5, { result: 'accepted' });
      expect(add).toHaveBeenCalledWith(2, { result: 'duplicate' });
    });

    it('accepted = 0 → AUCUN point accepted (anti-zero-noise)', () => {
      const svc = new MetricsService();

      svc.recordUsageEvents(0, 3);

      const add = counters.get('billing_usage_events_recorded_total')!.add;
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(3, { result: 'duplicate' });
    });

    it('duplicates = 0 → AUCUN point duplicate', () => {
      const svc = new MetricsService();

      svc.recordUsageEvents(7, 0);

      const add = counters.get('billing_usage_events_recorded_total')!.add;
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(7, { result: 'accepted' });
    });

    it('accepted = 0 ET duplicates = 0 → 0 point (cas batch vide)', () => {
      const svc = new MetricsService();

      svc.recordUsageEvents(0, 0);

      const add = counters.get('billing_usage_events_recorded_total')!.add;
      expect(add).not.toHaveBeenCalled();
    });

    it('accepted négatif → pas de point (`> 0` strict, pas `!= 0`)', () => {
      const svc = new MetricsService();

      // Cas pathologique défensif : ne devrait jamais arriver, mais si
      // c'était `!= 0`, un nombre négatif passerait et corromprait le total.
      svc.recordUsageEvents(-1, -1);

      const add = counters.get('billing_usage_events_recorded_total')!.add;
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('construction', () => {
    it('crée exactement 3 counters au boot', () => {
      new MetricsService();

      expect(counters.size).toBe(3);
      expect(counters.has('auth_attempts_total')).toBe(true);
      expect(counters.has('billing_quota_check_total')).toBe(true);
      expect(counters.has('billing_usage_events_recorded_total')).toBe(true);
    });
  });
});
