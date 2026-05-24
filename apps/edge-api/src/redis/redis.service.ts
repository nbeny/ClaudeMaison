import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('REDIS_URL', { infer: true });
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.client.on('error', (err) => {
      this.logger.error(`Redis erreur : ${err.message}`);
    });
  }

  async ping(): Promise<void> {
    const pong = await this.client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Redis ping inattendu : ${pong}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
