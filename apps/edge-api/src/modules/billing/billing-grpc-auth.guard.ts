import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Metadata } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env';

/**
 * Auth gRPC simple par bearer partagé dans la metadata `authorization`.
 * Compare en temps constant pour éviter les attaques par timing.
 *
 * Jour-1 : un seul secret pour tous les callers internes. À terme, on
 * remplacera par du mTLS via le maillage de services et ce guard disparaîtra
 * — ou se réduira à un check d'identité SPIFFE.
 *
 * Si BILLING_GRPC_TOKEN n'est pas configuré, le serveur gRPC n'est de toute
 * façon pas démarré (cf. main.ts) ; ce guard ne devrait donc jamais voir
 * d'appel sans token côté serveur.
 */
@Injectable()
export class BillingGrpcAuthGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor(config: ConfigService<Env, true>) {
    const token = config.get('BILLING_GRPC_TOKEN', { infer: true });
    this.expected = token ? Buffer.from(token, 'utf8') : null;
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.expected) {
      // Anti-déploiement-foireux : on refuse plutôt que d'accepter en clair.
      throw new UnauthorizedException('Billing gRPC: token non configuré.');
    }
    const meta = ctx.switchToRpc().getContext<Metadata>();
    const headers = meta.get('authorization');
    if (!headers || headers.length === 0) {
      throw new UnauthorizedException('authorization manquant.');
    }
    const raw = headers[0]!.toString();
    const prefix = 'Bearer ';
    if (!raw.startsWith(prefix)) {
      throw new UnauthorizedException('authorization mal formé.');
    }
    const presented = Buffer.from(raw.slice(prefix.length).trim(), 'utf8');
    if (
      presented.length !== this.expected.length ||
      !timingSafeEqual(presented, this.expected)
    ) {
      throw new UnauthorizedException('token billing gRPC invalide.');
    }
    return true;
  }
}
