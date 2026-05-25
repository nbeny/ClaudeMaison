import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import type { Env } from '../../../config/env';
import { AuthService } from '../auth.service';
import { OidcDiscoveryService } from './oidc-discovery.service';
import { OidcStateStore } from './oidc-state.store';
import { deriveCodeChallenge, generateCodeVerifier, generateRandomToken } from './pkce';

const PROVIDER = 'oidc';

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
}

@Controller('v1/auth/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly postLoginRedirect: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly discovery: OidcDiscoveryService,
    private readonly stateStore: OidcStateStore,
    private readonly auth: AuthService,
  ) {
    // Tous garantis présents : OidcModule ne s'enregistre que si le bloc OIDC
    // est complet (cf. AppModule#imports + env.ts superRefine).
    this.clientId = config.get('OIDC_CLIENT_ID', { infer: true })!;
    this.clientSecret = config.get('OIDC_CLIENT_SECRET', { infer: true })!;
    this.redirectUri = config.get('OIDC_REDIRECT_URI', { infer: true })!;
    const origins = config.get('ALLOWED_ORIGINS', { infer: true });
    this.postLoginRedirect =
      config.get('OIDC_POST_LOGIN_REDIRECT', { infer: true }) ??
      origins[0] ??
      'http://localhost:3001';
  }

  /**
   * Lance le flow OIDC : génère PKCE+state+nonce, mémorise en Redis,
   * redirige le browser vers l'IdP. `returnTo` (optionnel) permet au client
   * web de demander une redirection finale différente du défaut.
   */
  @Get('login')
  async login(
    @Query('returnTo') returnTo: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const state = generateRandomToken();
    const nonce = generateRandomToken();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);

    await this.stateStore.put(state, {
      codeVerifier,
      nonce,
      returnTo: this.sanitizeReturnTo(returnTo),
      createdAt: Date.now(),
    });

    const meta = this.discovery.getMetadata();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const url = `${meta.authorizationEndpoint}?${params.toString()}`;
    await reply.redirect(url, 302);
  }

  /**
   * Callback : valide state, échange code → tokens, vérifie l'ID token,
   * délègue le upsert user à AuthService, redirige vers le client web avec
   * nos tokens en fragment d'URL (jamais en query, pour éviter les fuites
   * dans les logs des proxies).
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (error) {
      this.logger.warn(
        `Callback OIDC en erreur : ${error} — ${errorDescription ?? '(no description)'}`,
      );
      throw new UnauthorizedException(`OIDC: ${error}`);
    }
    if (!code || !state) {
      throw new BadRequestException('Paramètres OIDC `code` et `state` requis.');
    }

    const stored = await this.stateStore.consume(state);
    if (!stored) {
      // State inconnu ou déjà consommé. Soit CSRF, soit replay, soit
      // expiration. Dans tous les cas, on refuse.
      throw new UnauthorizedException('State OIDC inconnu, expiré ou rejoué.');
    }

    const tokens = await this.exchangeCode(code, stored.codeVerifier);
    const claims = await this.verifyIdToken(tokens.id_token, stored.nonce);

    const email = typeof claims.email === 'string' ? claims.email : undefined;
    if (!email) {
      throw new UnauthorizedException(
        'ID token sans claim `email` — impossible de créer le compte.',
      );
    }
    if (claims.email_verified === false) {
      // On refuse les emails non vérifiés : sinon n'importe qui pourrait
      // créer un compte chez l'IdP avec l'email d'une victime et squatter
      // son compte local.
      throw new UnauthorizedException('Email non vérifié chez le provider OIDC.');
    }

    const issued = await this.auth.signinWithOidc(
      { provider: PROVIDER, subject: claims.sub!, email },
      {
        userAgent: req.headers['user-agent'] ?? null,
        ip: req.ip ?? null,
      },
    );

    // Tokens côté client : en fragment (#) pour rester hors des logs HTTP.
    // Le web peut lire window.location.hash, puis nettoyer l'URL.
    const target = new URL(stored.returnTo ?? this.postLoginRedirect);
    const fragment = new URLSearchParams({
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: Math.floor(
        (issued.accessTokenExpiresAt.getTime() - Date.now()) / 1000,
      ).toString(),
    });
    target.hash = fragment.toString();
    await reply.redirect(target.toString(), 302);
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const meta = this.discovery.getMetadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: codeVerifier,
    });
    const res = await fetch(meta.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logger.warn(`Échange code OIDC échoué : ${res.status} ${text}`);
      throw new UnauthorizedException('Échange code OIDC échoué.');
    }
    return (await res.json()) as TokenResponse;
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
  ): Promise<{ sub?: string; email?: string; email_verified?: boolean; nonce?: string }> {
    const meta = this.discovery.getMetadata();
    const { payload } = await jwtVerify(idToken, this.discovery.getJwks(), {
      issuer: meta.issuer,
      audience: this.clientId,
    });
    if (payload.nonce !== expectedNonce) {
      throw new UnauthorizedException('Nonce ID token invalide.');
    }
    if (typeof payload.sub !== 'string') {
      throw new UnauthorizedException('ID token sans `sub`.');
    }
    return payload as {
      sub: string;
      email?: string;
      email_verified?: boolean;
      nonce?: string;
    };
  }

  /**
   * Évite les redirections ouvertes : si le client demande un returnTo, on
   * vérifie qu'il pointe vers une origine autorisée. Sinon on l'ignore et
   * on utilisera le défaut.
   */
  private sanitizeReturnTo(input?: string): string | undefined {
    if (!input) return undefined;
    try {
      const parsed = new URL(input);
      const allowed = new URL(this.postLoginRedirect);
      if (parsed.origin === allowed.origin) return parsed.toString();
    } catch {
      // URL invalide → on ignore.
    }
    return undefined;
  }
}
