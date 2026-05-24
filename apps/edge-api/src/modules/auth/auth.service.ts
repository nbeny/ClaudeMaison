import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { FederatedIdentitiesRepository } from './federated-identities.repository';
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
    private readonly db: DatabaseService,
    private readonly federatedIdentities: FederatedIdentitiesRepository,
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

  /**
   * Connecte un utilisateur via une identité OIDC vérifiée. Trois cas :
   *
   *  - identité (provider, subject) déjà connue → on récupère l'user, on
   *    touche `last_login`, on émet les tokens.
   *  - identité inconnue mais email déjà chez nous (compte local existant)
   *    → on lie l'identité fédérée à l'user existant. C'est l'auto-merge
   *    classique des IdP qui valident les emails.
   *  - email inconnu → on crée un user sans password_hash + on attache
   *    l'identité fédérée. L'user pourra définir un mot de passe plus tard
   *    via un flow "set password" (non implémenté Jour-1).
   *
   * Tout est wrappé dans une transaction : la création du user et celle de
   * l'identité fédérée ne peuvent pas se désynchroniser, et le UNIQUE
   * (provider, subject) protège contre une course concurrente entre deux
   * callbacks pour le même user.
   */
  async signinWithOidc(
    input: { provider: string; subject: string; email: string },
    ctx: RequestContext = {},
  ): Promise<IssuedTokens> {
    const user = await this.db.sql.begin(async (tx) => {
      const existing = await this.federatedIdentities.findByProviderSubject(
        input.provider,
        input.subject,
        tx,
      );
      if (existing) {
        const linked = await this.users.findActiveById(existing.userId, tx);
        if (!linked) {
          throw new UnauthorizedException(
            'Identité fédérée orpheline (user supprimé) — contactez le support.',
          );
        }
        await this.federatedIdentities.touchLastLogin(existing.id, tx);
        return linked;
      }

      const byEmail = await this.users.findActiveByEmail(input.email, tx);
      if (byEmail) {
        await this.federatedIdentities.create(
          {
            userId: byEmail.id,
            provider: input.provider,
            subject: input.subject,
            email: input.email,
          },
          tx,
        );
        this.logger.log(
          `OIDC: identité ${input.provider}:${input.subject} liée au user existant ${byEmail.id}.`,
        );
        return byEmail;
      }

      const created = await this.users.createPasswordless({ email: input.email }, tx);
      await this.federatedIdentities.create(
        {
          userId: created.id,
          provider: input.provider,
          subject: input.subject,
          email: input.email,
        },
        tx,
      );
      this.logger.log(`OIDC: nouveau user ${created.id} créé via ${input.provider}.`);
      return created;
    });

    return this.issueTokens(user as UserRow, ctx);
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
