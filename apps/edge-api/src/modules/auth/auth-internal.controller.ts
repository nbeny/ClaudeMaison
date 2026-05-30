import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../conversations/internal-auth.guard';
import { FederatedIdentitiesRepository } from './federated-identities.repository';

/**
 * Endpoint interne service-à-service consommé par realtime après vérification
 * RS256 d'un access token Keycloak : il fournit le `subject` brut de l'IdP et
 * récupère le `userId` local (auth.users.id) correspondant. Realtime n'a pas
 * d'accès direct à Postgres — ce round-trip remplace la jointure DB.
 *
 * Protégé par `InternalAuthGuard` (header `x-internal-secret`). À terme, mTLS.
 */
@Controller('internal/auth/users')
@UseGuards(InternalAuthGuard)
export class AuthInternalController {
  constructor(private readonly federated: FederatedIdentitiesRepository) {}

  @Get('by-federated-subject')
  async byFederatedSubject(
    @Query('provider') provider: string,
    @Query('subject') subject: string,
  ): Promise<{ userId: string }> {
    if (!provider || !subject) {
      throw new BadRequestException('provider et subject sont requis.');
    }
    const row = await this.federated.findByProviderSubject(provider, subject);
    if (!row) {
      throw new NotFoundException(
        `Aucune identité fédérée pour (${provider}, ${subject}).`,
      );
    }
    return { userId: row.userId };
  }
}
