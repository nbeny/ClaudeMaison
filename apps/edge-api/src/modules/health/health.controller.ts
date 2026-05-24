import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  status: 'ok';
  uptime: number;
  timestamp: string;
  version: string;
  commit?: string;
}

@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  @Get('health')
  liveness(): HealthResponse {
    return this.snapshot();
  }

  // Devient un vrai check quand Postgres + Redis sont câblés (commit suivant).
  @Get('ready')
  readiness(): HealthResponse {
    return this.snapshot();
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
