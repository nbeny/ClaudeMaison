import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthInternalController } from './auth-internal.controller';
import type { FederatedIdentitiesRepository, FederatedIdentityRow } from './federated-identities.repository';

function makeRepo(row: FederatedIdentityRow | null): FederatedIdentitiesRepository {
  return {
    findByProviderSubject: vi.fn().mockResolvedValue(row),
  } as unknown as FederatedIdentitiesRepository;
}

describe('AuthInternalController.byFederatedSubject', () => {
  it('returns { userId } when the identity exists', async () => {
    const row: FederatedIdentityRow = {
      id: 'fid-1',
      userId: 'local-user-alice',
      provider: 'oidc',
      subject: 'kc-sub-alice',
      email: null,
      createdAt: new Date(),
      lastLogin: null,
    };
    const repo = makeRepo(row);
    const ctrl = new AuthInternalController(repo);

    const out = await ctrl.byFederatedSubject('oidc', 'kc-sub-alice');

    expect(out).toEqual({ userId: 'local-user-alice' });
    expect(repo.findByProviderSubject).toHaveBeenCalledWith('oidc', 'kc-sub-alice');
  });

  it('throws NotFoundException when no row matches', async () => {
    const ctrl = new AuthInternalController(makeRepo(null));
    await expect(ctrl.byFederatedSubject('oidc', 'unknown-sub')).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when provider is missing', async () => {
    const ctrl = new AuthInternalController(makeRepo(null));
    await expect(ctrl.byFederatedSubject('', 'kc-sub-alice')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when subject is missing', async () => {
    const ctrl = new AuthInternalController(makeRepo(null));
    await expect(ctrl.byFederatedSubject('oidc', '')).rejects.toThrow(BadRequestException);
  });
});
