import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PlansRepository } from './plans.repository';

/**
 * Plans par défaut, source unique côté code. Le seeder est idempotent
 * (UPSERT par slug) — on peut adapter les quotas ici et redéployer pour
 * répercuter la mise à jour sans toucher à la base à la main.
 *
 * Jour-1 : trois paliers. Les chiffres sont indicatifs et ajustables ;
 * pas d'engagement contractuel tant qu'il n'y a pas de tarification publique.
 */
const DEFAULT_PLANS = [
  {
    slug: 'free',
    name: 'Free',
    description: 'Découverte. Quotas serrés, idéal pour évaluer la plateforme.',
    quotaLlmTokens: 200_000,
    quotaEmbeddingsTokens: 100_000,
    quotaToolRuns: 50,
    quotaStorageGb: 1,
    priceEurMonthMicro: 0,
    isPublic: true,
  },
  {
    slug: 'pro',
    name: 'Pro',
    description: 'Usage intensif individuel. Tous les modèles disponibles.',
    quotaLlmTokens: 5_000_000,
    quotaEmbeddingsTokens: 5_000_000,
    quotaToolRuns: 2_000,
    quotaStorageGb: 50,
    priceEurMonthMicro: 25_000_000, // 25 €/mois
    isPublic: true,
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    description: 'Sur devis. SLA, isolation, support EU.',
    quotaLlmTokens: -1, // illimité
    quotaEmbeddingsTokens: -1,
    quotaToolRuns: -1,
    quotaStorageGb: -1,
    priceEurMonthMicro: 0, // tarification commerciale, non publique
    isPublic: false,
  },
];

@Injectable()
export class PlansSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlansSeeder.name);

  constructor(private readonly plans: PlansRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const plan of DEFAULT_PLANS) {
      await this.plans.upsert(plan);
    }
    this.logger.log(`Plans par défaut synchronisés (${DEFAULT_PLANS.length}).`);
  }
}
