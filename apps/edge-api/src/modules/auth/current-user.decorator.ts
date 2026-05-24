import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AccessTokenClaims } from './jwt.service';
import type { AuthenticatedRequest } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const req: AuthenticatedRequest =
      ctx.getType<'graphql'>() === 'graphql'
        ? GqlExecutionContext.create(ctx).getContext().req
        : ctx.switchToHttp().getRequest();
    if (!req.user) {
      throw new Error(
        '@CurrentUser() utilisé sans JwtAuthGuard préalable — incohérent.',
      );
    }
    return req.user;
  },
);
