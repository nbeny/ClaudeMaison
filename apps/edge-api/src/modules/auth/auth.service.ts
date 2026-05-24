import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../../config/env';
import { JwtService } from './jwt.service';
import { DUMMY_HASH, PasswordService } from './password.service';
import { SessionsRepository } from './sessions.repository';
import { UserRow, UsersRepository } from './users.repository';

export interface IssuedTokens {
  user: UserRow;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface RequestContext {
  userAgent?: string | null;
  ip?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {
    this.accessTtlSeconds = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtlSeconds = config.get('JWT_REFRESH_TTL_SECONDS', { infer: true });
  }

  async signup(
    input: { email: string; password: string },
    ctx: RequestContext = {},
  ): Promise<IssuedTokens> {
    const existing = await this.users.findActiveByEmail(input.email);
    if (existing) {
      // On répond le même code qu'une violation de contrainte unique, mais on
      // ne révèle pas l'email côté message — l'attaquant peut tester par
      // énumération de toute façon, ce n'est pas un secret. Ici on choisit la
      // clarté pour le client.
      throw new ConflictException('Email déjà utilisé.');
    }
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.users.createWithPassword({
      email: input.email,
      passwordHash,
    });
    return this.issueTokens(user, ctx);
  }

  async signin(
    input: { email: string; password: string },
    ctx: RequestContext = {},
  ): Promise<IssuedTokens> {
    const user = await this.users.findActiveByEmail(input.email);
    // Hash systématique même si l'utilisateur n'existe pas : on évite la
    // distinction de timing entre « email inconnu » et « mot de passe faux ».
    // Le hash factice est statique, son seul rôle est de consommer du CPU.
    const okHash = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = await this.passwords.verify(okHash, input.password);
    if (!user || !user.passwordHash || !passwordOk) {
      throw new UnauthorizedException('Identifiants invalides.');
    }
    return this.issueTokens(user, ctx);
  }

  async refresh(refreshToken: string, ctx: RequestContext = {}): Promise<IssuedTokens> {
    const hash = sha256(refreshToken);
    const session = await this.sessions.findByRefreshHash(hash);
    if (!session) {
      throw new UnauthorizedException('Refresh token invalide.');
    }

    if (session.revokedAt) {
      // Le token a déjà été utilisé une fois (ou révoqué). Si rotatedTo est
      // renseigné, c'est une réutilisation : on coupe toute la chaîne.
      if (session.rotatedTo) {
        this.logger.warn(
          `Réutilisation détectée du refresh ${session.id} → révocation en chaîne.`,
        );
        await this.sessions.revokeChain(session.id);
      }
      throw new UnauthorizedException('Refresh token invalide.');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Session expirée.');
    }

    const user = await this.users.findActiveById(session.userId);
    if (!user) {
      throw new UnauthorizedException('Utilisateur introuvable.');
    }

    // Rotation : nouvelle session, ancienne marquée comme rotated.
    const issued = await this.issueTokens(user, ctx);
    await this.sessions.markRotated(session.id, issued.sessionId);
    return issued;
  }

  async logout(refreshToken: string): Promise<void> {
    const hash = sha256(refreshToken);
    const session = await this.sessions.findByRefreshHash(hash);
    if (session && !session.revokedAt) {
      await this.sessions.revoke(session.id);
    }
  }

  private async issueTokens(user: UserRow, ctx: RequestContext): Promise<IssuedTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenHash = sha256(refreshToken);
    const refreshTokenExpiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    const accessTokenExpiresAt = new Date(Date.now() + this.accessTtlSeconds * 1000);

    const session = await this.sessions.create({
      userId: user.id,
      refreshTokenHash,
      expiresAt: refreshTokenExpiresAt,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });

    const accessToken = await this.jwt.signAccessToken({
      sub: user.id,
      sid: session.id,
    });

    return {
      user,
      sessionId: session.id,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
    };
  }
}

function sha256(input: string): Buffer {
  return createHash('sha256').update(input).digest();
}
