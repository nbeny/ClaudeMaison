import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../../config/env';

/**
 * Garde pour les endpoints `/internal/*` consommés service-à-service (ex:
 * realtime → edge-api). On vérifie un secret partagé en header
 * `x-internal-secret` validé contre `INTERNAL_SHARED_SECRET` du config.
 *
 * Phase 1 : comparaison `===` simple. À terme on bascule sur mTLS via le
 * maillage de services et cette garde disparaît.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers['x-internal-secret'];
    const expected = this.config.get('INTERNAL_SHARED_SECRET', { infer: true });
    if (typeof provided !== 'string' || provided !== expected) {
      this.logger.warn(
        { url: req.url, method: req.method },
        'internal endpoint hit without valid x-internal-secret',
      );
      throw new UnauthorizedException('internal secret missing or invalid');
    }
    return true;
  }
}
