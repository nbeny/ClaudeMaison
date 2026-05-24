import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../../common/zod.pipe';
import { AuthService, IssuedTokens, RequestContext } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { CredentialsInput, CredentialsSchema } from './dto/credentials.input';
import { RefreshInput, RefreshSchema } from './dto/refresh.input';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenClaims } from './jwt.service';
import { AuthPayload } from './models/auth-payload.model';
import { Viewer } from './models/viewer.model';
import { UsersRepository } from './users.repository';

@Resolver(() => Viewer)
export class AuthResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
  ) {}

  @Query(() => Viewer, { nullable: true })
  @UseGuards(JwtAuthGuard)
  async viewer(@CurrentUser() claims: AccessTokenClaims): Promise<Viewer | null> {
    const user = await this.users.findActiveById(claims.sub);
    if (!user) {
      return null;
    }
    return toViewer(user.id, user.email);
  }

  @Mutation(() => AuthPayload)
  async signup(
    @Args('input', new ZodValidationPipe(CredentialsSchema))
    input: CredentialsInput,
    @Context() ctx: { req: FastifyRequest },
  ): Promise<AuthPayload> {
    const issued = await this.auth.signup(input, requestContext(ctx.req));
    return toPayload(issued);
  }

  @Mutation(() => AuthPayload)
  async signin(
    @Args('input', new ZodValidationPipe(CredentialsSchema))
    input: CredentialsInput,
    @Context() ctx: { req: FastifyRequest },
  ): Promise<AuthPayload> {
    const issued = await this.auth.signin(input, requestContext(ctx.req));
    return toPayload(issued);
  }

  @Mutation(() => AuthPayload)
  async refresh(
    @Args('input', new ZodValidationPipe(RefreshSchema))
    input: RefreshInput,
    @Context() ctx: { req: FastifyRequest },
  ): Promise<AuthPayload> {
    const issued = await this.auth.refresh(input.refreshToken, requestContext(ctx.req));
    return toPayload(issued);
  }

  @Mutation(() => Boolean)
  async logout(
    @Args('input', new ZodValidationPipe(RefreshSchema)) input: RefreshInput,
  ): Promise<boolean> {
    await this.auth.logout(input.refreshToken);
    return true;
  }
}

function requestContext(req: FastifyRequest): RequestContext {
  return {
    userAgent: req.headers['user-agent'] ?? null,
    ip: req.ip ?? null,
  };
}

function toViewer(id: string, email: string): Viewer {
  // Workspaces : non câblés à l'étape 2. On retourne la liste vide ; la
  // requête `viewer` reste valide et le front peut commencer à se brancher.
  return Object.assign(new Viewer(), { id, email, workspaces: [] });
}

function toPayload(issued: IssuedTokens): AuthPayload {
  return Object.assign(new AuthPayload(), {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    accessTokenExpiresAt: issued.accessTokenExpiresAt,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
    viewer: toViewer(issued.user.id, issued.user.email),
  });
}
