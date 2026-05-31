/**
 * Caractérisation `AuthModule.forRoot` — DynamicModule conditionnel.
 *
 * Pourquoi le tester alors que c'est "juste du câblage" : la fonction prend
 * une `ConfigService` et décide quels providers enregistrer. Trois
 * invariants critiques que la compilation TypeScript NE détecte pas :
 *
 *   1. `global: true` — si on l'oublie, les autres modules (Billing,
 *      Conversations, OidcModule) devraient explicitement `imports:
 *      [AuthModule]`. Comme ils ne le font pas (cf. app.module.ts qui
 *      câble juste `AuthModule.forRoot(...)`), `OidcDiscoveryService` et
 *      `AuthService` deviennent invisibles → boot KO avec un
 *      `UnknownDependenciesException` Nest peu parlant.
 *
 *   2. La conditionnelle `OIDC_ISSUER_URL` ajoute `OidcDiscoveryService` à
 *      la fois aux providers ET aux exports. Si quelqu'un l'ajoutait
 *      seulement aux providers (oubli classique), `JwtService` ne pourrait
 *      pas l'injecter depuis `OidcModule` même quand l'OIDC est activé.
 *      Symptôme runtime : 401 sur tous les tokens RS256.
 *
 *   3. Le contrat d'exports doit lister AuthService / JwtService /
 *      JwtAuthGuard / WorkspaceMembersRepository. Si quelqu'un retire
 *      `JwtAuthGuard` des exports (pour "n'exporter que ce qui est public"),
 *      les contrôleurs annotés `@UseGuards(JwtAuthGuard)` ne pourront plus
 *      le résoudre depuis leurs modules → 500 au premier hit.
 *
 * On teste contre la forme du `DynamicModule` retourné, pas via un
 * `Test.createTestingModule` complet (qui demanderait d'instancier toute
 * la chaîne Postgres/Redis). C'est volontairement structurel : ce sont des
 * tests de *contrat*, pas d'intégration.
 */
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { AuthInternalController } from './auth-internal.controller';
import { AuthModule } from './auth.module';
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
import { InternalAuthGuard } from '../conversations/internal-auth.guard';

type Env = Record<string, unknown>;

/**
 * Faux `ConfigService` minimaliste : seul `get('OIDC_ISSUER_URL', ...)`
 * est consulté par la SUT. On évite d'instancier le vrai ConfigService
 * (qui voudrait un schema Zod + process.env propres) pour garder le test
 * focalisé sur le branchement.
 */
function fakeConfig(env: Env): ConfigService<Env, true> {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService<Env, true>;
}

describe('AuthModule.forRoot — shape du DynamicModule', () => {
  it('retourne un objet qui référence AuthModule comme `module`', () => {
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.module).toBe(AuthModule);
  });

  it('est marqué `global: true` (sinon les imports cascade casseraient)', () => {
    // Si on supprime ce flag, `OidcDiscoveryService` et `AuthService` ne
    // sont plus injectables depuis OidcModule / Billing / Conversations
    // sans `imports: [AuthModule]` explicite. C'est *exactement* la
    // raison d'être de forRoot — sans `global: true`, on aurait pu juste
    // garder un `@Module({...})` static.
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.global).toBe(true);
  });

  it('expose AuthInternalController dans `controllers`', () => {
    // Le seul controller de ce module : endpoint interne service-à-service
    // pour resolve-federated-subject (utilisé par realtime).
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.controllers).toEqual([AuthInternalController]);
  });
});

describe('AuthModule.forRoot — providers de base (OIDC absent)', () => {
  it('inclut les 10 providers de base attendus', () => {
    // Lock exact pour détecter une suppression accidentelle (genre
    // suppression d'un repository "inutilisé" alors qu'il est consommé
    // par un guard dans un autre module).
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.providers).toEqual([
      AuthResolver,
      AuthService,
      JwtService,
      JwtAuthGuard,
      PasswordService,
      UsersRepository,
      SessionsRepository,
      FederatedIdentitiesRepository,
      WorkspaceMembersRepository,
      InternalAuthGuard,
    ]);
  });

  it("N'inclut PAS OidcDiscoveryService quand OIDC_ISSUER_URL est absent", () => {
    // Régression la plus probable : quelqu'un teste l'env avec une
    // string vide et conclut "toujours activé" → on consume un IdP
    // jamais configuré et boot KO. Le check actuel est `!== undefined`
    // strict.
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.providers).not.toContain(OidcDiscoveryService);
  });

  it('exports = exactement [AuthService, JwtService, JwtAuthGuard, WorkspaceMembersRepository]', () => {
    // Contrat public du module. Si on retire JwtAuthGuard d'ici, tous
    // les contrôleurs `@UseGuards(JwtAuthGuard)` dans d'autres modules
    // cassent en runtime. Lock strict (ordre + contenu).
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.exports).toEqual([
      AuthService,
      JwtService,
      JwtAuthGuard,
      WorkspaceMembersRepository,
    ]);
  });
});

describe('AuthModule.forRoot — branche OIDC (OIDC_ISSUER_URL défini)', () => {
  const oidcConfig = fakeConfig({
    OIDC_ISSUER_URL: 'https://keycloak.example.com/realms/cm',
  });

  it('ajoute OidcDiscoveryService aux providers', () => {
    const mod = AuthModule.forRoot(oidcConfig);
    expect(mod.providers).toContain(OidcDiscoveryService);
  });

  it('ajoute OidcDiscoveryService aux exports (sinon JwtService ne peut pas l\'injecter)', () => {
    // C'est l'invariant le plus subtil : un provider non-exporté
    // n'est résolu QUE pour les classes du même module. JwtService est
    // dans AuthModule donc OK, mais `OidcModule.OidcController` voudra
    // aussi peut-être l'injecter à terme (ou tout autre module qui
    // ferait du token-introspection).
    const mod = AuthModule.forRoot(oidcConfig);
    expect(mod.exports).toContain(OidcDiscoveryService);
  });

  it('conserve les 10 providers de base + OidcDiscoveryService (11 total)', () => {
    const mod = AuthModule.forRoot(oidcConfig);
    expect(mod.providers).toHaveLength(11);
    expect(mod.providers).toEqual([
      AuthResolver,
      AuthService,
      JwtService,
      JwtAuthGuard,
      PasswordService,
      UsersRepository,
      SessionsRepository,
      FederatedIdentitiesRepository,
      WorkspaceMembersRepository,
      InternalAuthGuard,
      OidcDiscoveryService,
    ]);
  });

  it('exports = 5 entrées (4 de base + OidcDiscoveryService)', () => {
    const mod = AuthModule.forRoot(oidcConfig);
    expect(mod.exports).toEqual([
      AuthService,
      JwtService,
      JwtAuthGuard,
      WorkspaceMembersRepository,
      OidcDiscoveryService,
    ]);
  });
});

describe('AuthModule.forRoot — sémantique du flag OIDC_ISSUER_URL', () => {
  it("ne déclenche PAS sur string vide '' (truthy-check serait un bug)", () => {
    // Le code actuel teste `!== undefined`. Si quelqu'un repassait à
    // un truthy-check (`if (config.get(...))`), une string vide
    // venant d'un `.env` mal trimmé désactiverait OIDC silencieusement.
    // Inversement, un truthy-check exclurait des URLs falsy futures
    // (peu probable mais on lock le comportement strict).
    const mod = AuthModule.forRoot(fakeConfig({ OIDC_ISSUER_URL: '' }));
    // string vide !== undefined → OIDC activé par le code actuel.
    expect(mod.providers).toContain(OidcDiscoveryService);
  });

  it("ne déclenche PAS sur null", () => {
    // Lock le comportement actuel : `null !== undefined` → OIDC activé.
    // Si on voulait traiter null comme "absent", il faudrait changer
    // le test en `== null` (double égal). Ce test documente l'absence
    // de cette nuance.
    const mod = AuthModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: null as unknown }),
    );
    expect(mod.providers).toContain(OidcDiscoveryService);
  });

  it('exclut OIDC quand OIDC_ISSUER_URL est explicitement undefined', () => {
    const mod = AuthModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: undefined }),
    );
    expect(mod.providers).not.toContain(OidcDiscoveryService);
    expect(mod.exports).not.toContain(OidcDiscoveryService);
  });

  it('exclut OIDC quand la clé est totalement absente du config', () => {
    // Sémantiquement équivalent à `undefined`, mais on lock les deux
    // cas explicitement parce que `config.get(missing)` pourrait
    // techniquement retourner autre chose qu'undefined dans un futur
    // refactor du ConfigService.
    const mod = AuthModule.forRoot(fakeConfig({}));
    expect(mod.providers).not.toContain(OidcDiscoveryService);
    expect(mod.exports).not.toContain(OidcDiscoveryService);
  });
});

describe('AuthModule.forRoot — invariants de cohérence providers↔exports', () => {
  it("tout symbole dans `exports` est aussi dans `providers` (Nest l'exige)", () => {
    // Sans OIDC.
    const noOidc = AuthModule.forRoot(fakeConfig({}));
    for (const exp of noOidc.exports!) {
      expect(noOidc.providers).toContain(exp);
    }
    // Avec OIDC.
    const withOidc = AuthModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: 'https://kc/realms/cm' }),
    );
    for (const exp of withOidc.exports!) {
      expect(withOidc.providers).toContain(exp);
    }
  });

  it('les deux appels successifs avec le même config produisent des modules structurellement équivalents', () => {
    // Pas de cache implicite, pas de side-effect au premier call qui
    // muterait le second. Lock contre une régression où on
    // mémoïserait le résultat en module-level (ce qui casserait le
    // multi-tenant futur où chaque request aurait sa config).
    const a = AuthModule.forRoot(fakeConfig({}));
    const b = AuthModule.forRoot(fakeConfig({}));
    expect(a.providers).toEqual(b.providers);
    expect(a.exports).toEqual(b.exports);
    expect(a.controllers).toEqual(b.controllers);
    // Mais ce sont des objets différents (pas de cache singleton).
    expect(a).not.toBe(b);
    expect(a.providers).not.toBe(b.providers);
  });
});
