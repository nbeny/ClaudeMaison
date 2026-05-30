import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { AuthResolver } from './auth.resolver';
import { AuthService } from './auth.service';
import { FederatedIdentitiesRepository } from './federated-identities.repository';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtService } from './jwt.service';
import { OidcDiscoveryService } from './oidc/oidc-discovery.service';
import { PasswordService } from './password.service';
import { SessionsRepository } from './sessions.repository';
import { UsersRepository } from './users.repository';
import { WorkspaceMembersRepository } from './workspace-members.repository';

/**
 * Module d'auth dynamique : si OIDC est configuré, on enregistre aussi
 * `OidcDiscoveryService` ici et on l'exporte, ce qui permet à `JwtService`
 * de l'injecter (chemin RS256 Keycloak) sans créer de cycle avec `OidcModule`.
 *
 * Marqué global pour que les modules consommateurs (Billing, Conversations,
 * Oidc) puissent continuer à faire `imports: [AuthModule]` sans avoir à
 * recevoir la version dynamique via une chaîne de `forRoot`.
 */
@Module({})
export class AuthModule {
  static forRoot(config: ConfigService<Env, true>): DynamicModule {
    const oidcEnabled =
      config.get('OIDC_ISSUER_URL', { infer: true }) !== undefined;

    const providers: Provider[] = [
      AuthResolver,
      AuthService,
      JwtService,
      JwtAuthGuard,
      PasswordService,
      UsersRepository,
      SessionsRepository,
      FederatedIdentitiesRepository,
      WorkspaceMembersRepository,
    ];
    const exportsList: Provider[] = [
      AuthService,
      JwtService,
      JwtAuthGuard,
      WorkspaceMembersRepository,
    ];

    if (oidcEnabled) {
      providers.push(OidcDiscoveryService);
      exportsList.push(OidcDiscoveryService);
    }

    return {
      module: AuthModule,
      global: true,
      providers,
      exports: exportsList,
    };
  }
}
