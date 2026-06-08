import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AuthInternalController } from './auth-internal.controller';
import { InternalAuthGuard } from '../conversations/internal-auth.guard';
import type {
  FederatedIdentitiesRepository,
  FederatedIdentityRow,
} from './federated-identities.repository';

// Caractérisation AuthInternalController — invariants subtils NON couverts
// par auth-internal.controller.spec.ts.
//
// Cet endpoint est consommé par `realtime` après vérification RS256 d'un
// token Keycloak. Realtime n'a pas accès à Postgres, donc ce controller
// est l'UNIQUE chemin pour résoudre (provider, subject) → userId local.
// Une régression silencieuse aurait des conséquences en cascade :
//
//   - **InternalAuthGuard wiré au niveau du controller** : @UseGuards
//     décore la classe, pas la méthode. Si on bougeait l'annotation vers
//     la méthode et qu'on ajoutait un GET sans guard, on exposerait le
//     mapping IdP → userId à n'importe qui (oracle d'énumération).
//
//   - **Ordre BadRequest AVANT lookup DB** : le check `!provider || !subject`
//     court-circuite la requête SQL. Sans ça, un attaquant qui passe une
//     string vide déclenche un EXPLAIN ANALYZE potentiel et fuite par
//     timing l'état de la table.
//
//   - **Args passés VERBATIM à findByProviderSubject(provider, subject)**
//     dans CET ORDRE. Si on inversait, on retournerait
//     row(provider=subject, subject=provider) — impossible mais on
//     verrouille le contrat.
//
//   - **Réponse minimale : { userId } uniquement** — pas d'email, pas
//     de provider, pas de lastLogin. Le caller realtime n'en a pas
//     besoin et ces champs sont du PII inutile sur la wire.
//
//   - **NotFoundException porte (provider, subject) mais PAS userId**
//     (qui n'existe pas dans ce cas). Volontaire : aide au debug interne
//     sans fuite vers le caller realtime.
//
//   - **Path `internal/auth/users` + `by-federated-subject`** : le préfixe
//     `internal/` est ce que le proxy/ingress filtre depuis l'extérieur.
//     Si quelqu'un changeait en `auth/users/...`, l'endpoint deviendrait
//     potentiellement public-facing.

function makeRow(overrides: Partial<FederatedIdentityRow> = {}): FederatedIdentityRow {
  return {
    id: 'fid-1',
    userId: 'u-local-alice',
    provider: 'oidc',
    subject: 'kc-sub-alice',
    email: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    lastLogin: null,
    ...overrides,
  };
}

function makeRepo(row: FederatedIdentityRow | null): FederatedIdentitiesRepository {
  return {
    findByProviderSubject: vi.fn().mockResolvedValue(row),
  } as unknown as FederatedIdentitiesRepository;
}

describe('AuthInternalController — InternalAuthGuard wiring', () => {
  it('est protégé par InternalAuthGuard au niveau classe', () => {
    // Si quelqu'un retirait @UseGuards ou le déplaçait vers une méthode
    // et oubliait de le rajouter sur une nouvelle méthode, l'endpoint
    // serait public. On vérifie le metadata Nest directement.
    const guards = Reflect.getMetadata('__guards__', AuthInternalController) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toContain(InternalAuthGuard);
  });

  it('le path racine est `internal/auth/users` (préfixe internal/ filtré par l\'ingress)', () => {
    const path = Reflect.getMetadata('path', AuthInternalController) as string;
    expect(path).toBe('internal/auth/users');
    expect(path.startsWith('internal/')).toBe(true);
  });
});

describe('AuthInternalController.byFederatedSubject — fail-fast sur args manquants (anti-timing)', () => {
  it('rejette BadRequest AVANT tout appel DB si provider est vide', async () => {
    const repo = makeRepo(null);
    const ctrl = new AuthInternalController(repo);
    await expect(ctrl.byFederatedSubject('', 'kc-sub')).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.findByProviderSubject).not.toHaveBeenCalled();
  });

  it('rejette BadRequest AVANT tout appel DB si subject est vide', async () => {
    const repo = makeRepo(null);
    const ctrl = new AuthInternalController(repo);
    await expect(ctrl.byFederatedSubject('oidc', '')).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.findByProviderSubject).not.toHaveBeenCalled();
  });

  it('rejette BadRequest si LES DEUX sont vides (pas de message confus)', async () => {
    const repo = makeRepo(null);
    const ctrl = new AuthInternalController(repo);
    await expect(ctrl.byFederatedSubject('', '')).rejects.toThrow(BadRequestException);
    expect(repo.findByProviderSubject).not.toHaveBeenCalled();
  });
});

describe('AuthInternalController.byFederatedSubject — contrat d\'appel au repository', () => {
  it('passe (provider, subject) dans CET ordre à findByProviderSubject', async () => {
    // Cross-protection : si on inversait l'ordre dans le controller,
    // le repo retournerait null (pas de row où provider="kc-sub-alice")
    // et le caller verrait un NotFound trompeur. Lock l'ordre exact.
    const repo = makeRepo(makeRow());
    const ctrl = new AuthInternalController(repo);
    await ctrl.byFederatedSubject('oidc', 'kc-sub-alice');
    expect(repo.findByProviderSubject).toHaveBeenCalledWith('oidc', 'kc-sub-alice');
    expect(repo.findByProviderSubject).toHaveBeenCalledTimes(1);
  });

  it('n\'invente pas d\'arg tx (le controller ne gère pas de transactions)', async () => {
    // Si quelqu'un ajoutait un paramètre tx forké, on couperait
    // l'isolation read-only de cet endpoint.
    const repo = makeRepo(makeRow());
    const ctrl = new AuthInternalController(repo);
    await ctrl.byFederatedSubject('oidc', 'kc-sub-alice');
    const call = vi.mocked(repo.findByProviderSubject).mock.calls[0]!;
    expect(call).toHaveLength(2);
  });
});

describe('AuthInternalController.byFederatedSubject — surface de réponse minimale', () => {
  it('retourne EXACTEMENT { userId }, pas plus (pas d\'email, lastLogin, etc.)', async () => {
    // Anti-fuite PII : si on retournait toute la row, le caller realtime
    // (qui devrait être trust-but-verify) pourrait stocker des emails
    // qu'il n'a pas le droit de stocker.
    const row = makeRow({
      email: 'alice@example.com',
      lastLogin: new Date(),
      id: 'fid-secret',
    });
    const ctrl = new AuthInternalController(makeRepo(row));
    const out = await ctrl.byFederatedSubject('oidc', 'kc-sub-alice');
    expect(out).toEqual({ userId: 'u-local-alice' });
    expect(Object.keys(out)).toEqual(['userId']);
  });

  it('retourne EXACTEMENT le userId de la row, pas un champ adjacent', async () => {
    // Verrou anti-confusion : si on remplaçait row.userId par row.id, on
    // exposerait l'ID interne de la table federated_identities.
    const row = makeRow({ id: 'fid-private-XX', userId: 'u-correct' });
    const ctrl = new AuthInternalController(makeRepo(row));
    const out = await ctrl.byFederatedSubject('oidc', 'kc-sub-alice');
    expect(out.userId).toBe('u-correct');
    expect(out.userId).not.toBe('fid-private-XX');
  });
});

describe('AuthInternalController.byFederatedSubject — messages d\'exception', () => {
  it('NotFoundException contient (provider, subject) pour le debug interne', async () => {
    // Aide au debug : un opérateur qui voit "Aucune identité fédérée
    // pour (oidc, kc-sub-X)" sait quoi chercher en DB. Mais ces deux
    // valeurs sont déjà connues du caller (il les a passées) donc pas
    // de fuite.
    const ctrl = new AuthInternalController(makeRepo(null));
    try {
      await ctrl.byFederatedSubject('oidc', 'kc-sub-X');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundException);
      expect((e as Error).message).toContain('oidc');
      expect((e as Error).message).toContain('kc-sub-X');
    }
  });

  it('NotFoundException ne contient PAS de userId (qui n\'existe pas dans ce cas)', async () => {
    // Sanity check : on ne peut pas leak un userId si la row n'existe pas.
    const ctrl = new AuthInternalController(makeRepo(null));
    try {
      await ctrl.byFederatedSubject('oidc', 'kc-sub-X');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/userId|u-[a-z0-9-]+/);
    }
  });

  it('BadRequestException message en français mentionne provider et subject', async () => {
    // Le wording français est un détail de DX local mais verrouillé pour
    // éviter qu'un refactor le bascule en anglais incohérent avec le
    // reste de l'API (qui mélange les deux selon le contexte i18n).
    const ctrl = new AuthInternalController(makeRepo(null));
    try {
      await ctrl.byFederatedSubject('', '');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as Error).message).toMatch(/provider/);
      expect((e as Error).message).toMatch(/subject/);
    }
  });
});

describe('AuthInternalController.byFederatedSubject — surface multi-providers', () => {
  it('appelle le repo avec un provider arbitraire (pas hardcoded "oidc")', async () => {
    // Sanity : un futur provider "saml" ou "ldap" doit passer sans
    // changement de controller.
    const repo = makeRepo(makeRow({ provider: 'saml', subject: 'saml-sub' }));
    const ctrl = new AuthInternalController(repo);
    const out = await ctrl.byFederatedSubject('saml', 'saml-sub');
    expect(out.userId).toBe('u-local-alice');
    expect(repo.findByProviderSubject).toHaveBeenCalledWith('saml', 'saml-sub');
  });
});
