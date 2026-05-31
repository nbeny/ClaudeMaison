/**
 * Caractérisation `OidcModule.forRoot` — DynamicModule conditionnel.
 *
 * Symétrique de `AuthModule.forRoot` mais avec une logique inverse : si
 * `OIDC_ISSUER_URL` est *absent*, on retourne un module *vide*. C'est ce
 * qui permet à edge-api de booter en CI minimale ou en dev sans Keycloak
 * sans 500 à l'init.
 *
 * Invariants critiques :
 *
 *   1. Branche "OIDC absent" → `{ module: OidcModule }` *strictement*, pas
 *      de `controllers`, pas de `providers`, pas de `exports`. Si quelqu'un
 *      mettait `controllers: []` au lieu de l'omettre, Nest traiterait ça
 *      comme une liste vide explicite ; sémantiquement identique mais lock
 *      le contrat actuel pour éviter qu'un refactor introduise un controller
 *      conditionnel mal câblé.
 *
 *   2. Branche "OIDC présent" → controller `OidcController` (login + callback
 *      handlers), provider `OidcStateStore` (state OIDC stocké en Redis),
 *      et `OidcStateStore` exporté (pour que d'autres modules puissent
 *      l'injecter si besoin — pas le cas Jour-1 mais le contrat est posé).
 *
 *   3. Pas de flag `global: true` ici (contrairement à AuthModule) : ce
 *      module est consommé uniquement via son enregistrement dans
 *      `AppModule`. Si quelqu'un ajoutait `global: true` par mimétisme
 *      avec AuthModule, on aurait `OidcController` accessible globalement,
 *      ce qui n'a pas de sens (le controller est routable par Nest, pas
 *      injecté).
 *
 *   4. Le log de désactivation utilise `Logger.log()` (info), pas `warn()`
 *      ni `error()` : l'absence d'OIDC est un état nominal, pas une erreur.
 *      Lock léger contre une future "élévation du niveau".
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcController } from './oidc.controller';
import { OidcModule } from './oidc.module';
import { OidcStateStore } from './oidc-state.store';

type Env = Record<string, unknown>;

function fakeConfig(env: Env): ConfigService<Env, true> {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService<Env, true>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OidcModule.forRoot — branche désactivée (OIDC_ISSUER_URL absent)', () => {
  it('retourne un module minimal avec uniquement la référence à OidcModule', () => {
    // Lock le contrat strict : pas de controllers, pas de providers, pas
    // d'exports. C'est ce qui permet à edge-api de booter sans Keycloak.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mod = OidcModule.forRoot(fakeConfig({}));
    expect(mod.module).toBe(OidcModule);
    expect(mod.controllers).toBeUndefined();
    expect(mod.providers).toBeUndefined();
    expect(mod.exports).toBeUndefined();
    logSpy.mockRestore();
  });

  it('log un message info expliquant la désactivation', () => {
    // Le message doit mentionner le nom de l'env var pour qu'un dev qui
    // lit les logs comprenne *pourquoi* OIDC est off (pas juste "OIDC
    // désactivé").
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    OidcModule.forRoot(fakeConfig({}));
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = String(logSpy.mock.calls[0]?.[0]);
    expect(message).toMatch(/OIDC_ISSUER_URL/);
  });

  it('utilise level=log (info), pas warn ni error', () => {
    // L'absence d'OIDC est nominale (CI minimale, dev sans Keycloak),
    // pas une erreur. Si quelqu'un passe à warn pour "être plus visible",
    // tous les déploiements sans Keycloak floodent les logs warn et
    // deviennent indistinguables des vraies alertes.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    OidcModule.forRoot(fakeConfig({}));
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('OidcModule.forRoot — branche activée (OIDC_ISSUER_URL défini)', () => {
  const oidcConfig = fakeConfig({
    OIDC_ISSUER_URL: 'https://keycloak.example.com/realms/cm',
  });

  it('enregistre OidcController dans controllers', () => {
    const mod = OidcModule.forRoot(oidcConfig);
    expect(mod.controllers).toEqual([OidcController]);
  });

  it('enregistre OidcStateStore dans providers', () => {
    // OidcStateStore (state CSRF stocké en Redis) est consommé par
    // OidcController pour le PKCE flow. Sans lui, callback handler
    // crashe en injection.
    const mod = OidcModule.forRoot(oidcConfig);
    expect(mod.providers).toEqual([OidcStateStore]);
  });

  it('exporte OidcStateStore', () => {
    // L'export n'est pas strictement nécessaire Jour-1 (rien d'extérieur
    // ne l'injecte), mais le contrat est posé : si demain on veut
    // partager le state-store avec un module CLI ou test-bench, c'est
    // déjà exporté.
    const mod = OidcModule.forRoot(oidcConfig);
    expect(mod.exports).toEqual([OidcStateStore]);
  });

  it("ne pollue PAS la sortie avec un log de désactivation", () => {
    // Si quelqu'un déplace le log hors du `if (!enabled)`, on logguerait
    // "OIDC désactivé" pendant que l'OIDC est activé → confusion ops.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    OidcModule.forRoot(oidcConfig);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("N'est PAS marqué `global: true`", () => {
    // OidcController est routable (Nest enregistre ses routes HTTP),
    // pas injectable globalement. `global: true` serait du
    // cargo-culting de AuthModule et n'aurait pas de sémantique utile.
    const mod = OidcModule.forRoot(oidcConfig);
    expect(mod.global).toBeUndefined();
  });
});

describe('OidcModule.forRoot — sémantique du flag OIDC_ISSUER_URL', () => {
  it("string vide '' est traité comme défini (`!== undefined`)", () => {
    // Cohérence avec AuthModule.forRoot — les deux modules doivent
    // s'activer/désactiver ensemble, sinon on aurait OidcDiscoveryService
    // enregistré dans AuthModule mais OidcController absent → controller
    // qui ne se câble pas, état incohérent.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mod = OidcModule.forRoot(fakeConfig({ OIDC_ISSUER_URL: '' }));
    expect(mod.controllers).toEqual([OidcController]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('null est traité comme défini (pas comme absent)', () => {
    // Lock le comportement actuel : `null !== undefined`. Si quelqu'un
    // voulait null-tolerant il devrait changer en `== null`.
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mod = OidcModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: null as unknown }),
    );
    expect(mod.controllers).toEqual([OidcController]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('explicit undefined → désactivé', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mod = OidcModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: undefined }),
    );
    expect(mod.controllers).toBeUndefined();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it('clé totalement absente → désactivé', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const mod = OidcModule.forRoot(fakeConfig({}));
    expect(mod.controllers).toBeUndefined();
    expect(logSpy).toHaveBeenCalledOnce();
  });
});

describe('OidcModule.forRoot — cohérence providers↔exports', () => {
  it('tout symbole dans exports est aussi dans providers', () => {
    const mod = OidcModule.forRoot(
      fakeConfig({ OIDC_ISSUER_URL: 'https://kc/realms/cm' }),
    );
    for (const exp of mod.exports!) {
      expect(mod.providers).toContain(exp);
    }
  });

  it('deux appels produisent des objets distincts (pas de cache singleton)', () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const a = OidcModule.forRoot(fakeConfig({}));
    const b = OidcModule.forRoot(fakeConfig({}));
    expect(a).not.toBe(b);
    // Mais structurellement équivalents.
    expect(a.module).toBe(b.module);
    expect(a.controllers).toBe(b.controllers); // both undefined
    expect(a.providers).toBe(b.providers); // both undefined
    logSpy.mockRestore();
  });
});

describe('OidcModule.forRoot — invariants de boot', () => {
  it("appelle config.get une seule fois, avec la clé exacte 'OIDC_ISSUER_URL'", () => {
    // Lock contre une régression où on lirait deux env vars ("OIDC_ISSUER_URL"
    // ET "OIDC_CLIENT_ID") pour décider, ce qui rendrait la désactivation
    // ambiguë. La décision doit dépendre d'une *seule* variable.
    const calls: Array<string | symbol> = [];
    const cfg = {
      get: (key: string) => {
        calls.push(key);
        return undefined;
      },
    } as unknown as ConfigService<Env, true>;
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    OidcModule.forRoot(cfg);
    expect(calls).toEqual(['OIDC_ISSUER_URL']);
    logSpy.mockRestore();
  });
});
