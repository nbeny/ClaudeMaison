import { Injectable } from '@nestjs/common';
import { metrics, type Counter } from '@opentelemetry/api';

/**
 * Façade fine au-dessus de l'API metrics d'OTel. Centraliser ici évite que
 * chaque service appelle `metrics.getMeter()` à la main et garantit qu'un
 * renommage de métrique se fait à un seul endroit.
 *
 * Le SDK n'est pas obligatoire pour utiliser ces counters : l'API
 * @opentelemetry/api renvoie des handles no-op tant qu'un MeterProvider
 * global n'est pas enregistré (cf. telemetry.ts).
 */
@Injectable()
export class MetricsService {
  private readonly authAttempts: Counter;
  private readonly billingQuotaChecks: Counter;
  private readonly billingUsageRecorded: Counter;

  constructor() {
    const meter = metrics.getMeter('edge-api', '1.0.0');

    this.authAttempts = meter.createCounter('auth_attempts_total', {
      description: 'Tentatives d’authentification (signup/signin/refresh/oidc).',
    });

    this.billingQuotaChecks = meter.createCounter('billing_quota_check_total', {
      description: 'Appels à QuotaService.check, taggés par kind et allowed.',
    });

    this.billingUsageRecorded = meter.createCounter(
      'billing_usage_events_recorded_total',
      {
        description:
          'Événements d’usage écrits via gRPC, distingue accepted et duplicates.',
      },
    );
  }

  recordAuthAttempt(kind: AuthAttemptKind, result: AuthAttemptResult): void {
    this.authAttempts.add(1, { kind, result });
  }

  recordQuotaCheck(usageKind: string, allowed: boolean): void {
    this.billingQuotaChecks.add(1, { kind: usageKind, allowed: String(allowed) });
  }

  recordUsageEvents(accepted: number, duplicates: number): void {
    if (accepted > 0) {
      this.billingUsageRecorded.add(accepted, { result: 'accepted' });
    }
    if (duplicates > 0) {
      this.billingUsageRecorded.add(duplicates, { result: 'duplicate' });
    }
  }
}

export type AuthAttemptKind = 'signup' | 'signin' | 'refresh' | 'logout' | 'oidc';
export type AuthAttemptResult = 'success' | 'failure';
