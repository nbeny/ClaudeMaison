import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../../config/env';

/**
 * Garde pour les endpoints `/internal/*` consommés service-à-service (ex:
 * realtime → edge-api). On vérifie un secret partagé en header
 * `x-internal-secret` validé contre `INTERNAL_SHARED_SECRET` du config.
 *
 * Comparaison constant-time pour ne pas exposer la longueur du secret via
 * timing. À terme on bascule sur mTLS via le maillage de services et cette
 * garde disparaît.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);
  private readonly expected: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const secret: string = config.get('INTERNAL_SHARED_SECRET', { infer: true });
    this.expected = Buffer.from(secret, 'utf8');
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers['x-internal-secret'];
    if (typeof provided !== 'string' || !this.matches(provided)) {
      this.logger.warn(
        { url: req.url, method: req.method },
        'internal endpoint hit without valid x-internal-secret',
      );
      throw new UnauthorizedException('internal secret missing or invalid');
    }
    return true;
  }

  private matches(provided: string): boolean {
    const buf = Buffer.from(provided, 'utf8');
    if (buf.length !== this.expected.length) return false;
    return timingSafeEqual(buf, this.expected);
  }
}
