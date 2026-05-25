import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingGrpcAuthGuard } from './billing-grpc-auth.guard';
import { BillingGrpcController } from './billing-grpc.controller';
import { BillingResolver } from './billing.resolver';
import { BillingService } from './billing.service';
import { PlansRepository } from './plans.repository';
import { PlansSeeder } from './plans.seeder';
import { QuotaService } from './quota.service';
import { SubscriptionsRepository } from './subscriptions.repository';
import { UsageEventsRepository } from './usage-events.repository';

@Module({
  imports: [AuthModule],
  controllers: [BillingGrpcController],
  providers: [
    BillingResolver,
    BillingService,
    QuotaService,
    PlansRepository,
    SubscriptionsRepository,
    UsageEventsRepository,
    PlansSeeder,
    BillingGrpcAuthGuard,
  ],
  exports: [BillingService, QuotaService],
})
export class BillingModule {}
