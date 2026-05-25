import { Field, ObjectType } from '@nestjs/graphql';
import { Plan } from './plan.model';
import { QuotaStatusModel } from './quota-status.model';

@ObjectType()
export class BillingSummary {
  @Field()
  workspaceId!: string;

  @Field(() => Plan)
  plan!: Plan;

  @Field()
  periodStart!: Date;

  @Field()
  periodEnd!: Date;

  // Une entrée par kind d'usage défini (USAGE_KINDS). Le front itère sur
  // ce tableau plutôt que de connaître chaque champ par nom.
  @Field(() => [QuotaStatusModel])
  quotas!: QuotaStatusModel[];
}
