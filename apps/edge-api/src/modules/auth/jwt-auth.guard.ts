import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { FastifyRequest } from 'fastify';
import type { AccessTokenClaims } from './jwt.service';
import { JwtService } from './jwt.service';

export interface AuthenticatedRequest extends FastifyRequest {
  user?: AccessTokenClaims;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = this.requestFrom(ctx);
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token manquant.');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      req.user = await this.jwt.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('Bearer token invalide ou expiré.');
    }
    return true;
  }

  private requestFrom(ctx: ExecutionContext): AuthenticatedRequest {
    if (ctx.getType<'graphql'>() === 'graphql') {
      return GqlExecutionContext.create(ctx).getContext().req;
    }
    return ctx.switchToHttp().getRequest();
  }
}
