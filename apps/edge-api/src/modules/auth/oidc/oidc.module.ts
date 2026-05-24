import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env';
import { AuthModule } from '../auth.module';
import { OidcController } from './oidc.controller';
import { OidcDiscoveryService } from './oidc-discovery.service';
import { OidcStateStore } from './oidc-state.store';

/**
 * Module OIDC, conditionnellement enregistré : si `OIDC_ISSUER_URL` n'est
 * pas défini, on n'enregistre ni controller ni service. Cela évite que le
 * binaire échoue à booter dans les environnements où l'OIDC n'est pas utilisé
 * (CI minimale, dev local sans Keycloak, etc.).
 */
@Module({})
export class OidcModule {
  static forRoot(config: ConfigService<Env, true>): DynamicModule {
    const enabled = config.get('OIDC_ISSUER_URL', { infer: true }) !== undefined;
    if (!enabled) {
      new Logger(OidcModule.name).log(
        'OIDC désactivé (OIDC_ISSUER_URL absent) — controller non enregistré.',
      );
      return { module: OidcModule };
    }
    return {
      module: OidcModule,
      imports: [AuthModule],
      controllers: [OidcController],
      providers: [OidcDiscoveryService, OidcStateStore],
      exports: [OidcDiscoveryService, OidcStateStore],
    };
  }
}
