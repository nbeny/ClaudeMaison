import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

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
  };
}

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(private readonly db: DatabaseService) {}

  @Get('health')
  liveness(): HealthResponse {
    return this.snapshot();
  }

  @Get('ready')
  async readiness(): Promise<ReadyResponse> {
    try {
      await this.db.ping();
    } catch (err) {
      this.logger.warn({ err }, 'Postgres ping a échoué.');
      throw new HttpException(
        { ...this.snapshot(), status: 'fail', checks: { postgres: 'fail' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ...this.snapshot(), checks: { postgres: 'ok' } };
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
