import { Query, Resolver } from '@nestjs/graphql';
import { HealthStatus } from './models/health-status.model';

@Resolver()
export class SystemResolver {
  @Query(() => HealthStatus, { description: 'Santé du service edge-api.' })
  health(): HealthStatus {
    return {
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.1',
      commit: process.env.GIT_COMMIT,
    };
  }
}
