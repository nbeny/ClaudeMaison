import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../redis/redis.service';

interface HealthResponse {
  status: 'ok';
  uptime: number;
  timestamp: string;
  version: string;
  commit?: string;
}

interface ReadyResponse extends HealthResponse {
  checks: {
    postgres: 'ok' | 'fail';
    redis: 'ok' | 'fail';
  };
}

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  liveness(): HealthResponse {
    return this.snapshot();
  }

  @Get('ready')
  async readiness(): Promise<ReadyResponse> {
    const [pg, rd] = await Promise.all([
      this.db.ping().then(() => 'ok' as const).catch((err) => {
        this.logger.warn({ err }, 'Postgres ping a échoué.');
        return 'fail' as const;
      }),
      this.redis.ping().then(() => 'ok' as const).catch((err) => {
        this.logger.warn({ err }, 'Redis ping a échoué.');
        return 'fail' as const;
      }),
    ]);
    const checks = { postgres: pg, redis: rd };
    if (pg === 'fail' || rd === 'fail') {
      throw new HttpException(
        { ...this.snapshot(), status: 'fail', checks },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ...this.snapshot(), checks };
  }

  private snapshot(): HealthResponse {
    return {
      status: 'ok',
      uptime: (Date.now() - this.startedAt) / 1000,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.0.1',
      commit: process.env.GIT_COMMIT,
    };
  }
}
