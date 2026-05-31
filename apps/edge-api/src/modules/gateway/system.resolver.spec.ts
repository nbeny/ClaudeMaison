import { beforeEach, describe, expect, it } from 'vitest';
import { SystemResolver } from './system.resolver';

// SystemResolver expose une Query GraphQL `health` consommée par les
// frontends (header status, monitoring custom) et le smoke E2E.
//
// Le contrat est :
//   - status est CONSTANT 'ok' (le resolver n'a pas accès aux deps —
//     ce n'est pas un readiness, c'est un check de "le service répond
//     en GraphQL"). Le fail-loud du readiness est dans HealthController.
//   - version vient de npm_package_version (injecté par pnpm au runtime)
//     avec fallback '0.0.1'. Une version manquante en prod = bug, mais
//     le client doit pouvoir afficher quelque chose.
//   - commit vient de GIT_COMMIT (injecté par le CI au build). Optionnel
//     en dev. Le client ne plante pas si absent.

describe('SystemResolver.health', () => {
  beforeEach(() => {
    delete process.env.npm_package_version;
    delete process.env.GIT_COMMIT;
  });

  it('renvoie status: "ok" (constant, pas calculé)', () => {
    const res = new SystemResolver().health();

    expect(res.status).toBe('ok');
  });

  it('renvoie version depuis npm_package_version quand présent', () => {
    process.env.npm_package_version = '1.2.3';

    const res = new SystemResolver().health();

    expect(res.version).toBe('1.2.3');
  });

  it('fallback version "0.0.1" quand npm_package_version absent', () => {
    // Garantit que le frontend ne reçoit JAMAIS undefined/null sur version,
    // donc l'affichage du header status ne crash pas.
    const res = new SystemResolver().health();

    expect(res.version).toBe('0.0.1');
  });

  it('expose commit depuis GIT_COMMIT quand présent', () => {
    process.env.GIT_COMMIT = 'deadbeef';

    const res = new SystemResolver().health();

    expect(res.commit).toBe('deadbeef');
  });

  it('commit est undefined quand GIT_COMMIT absent (PAS fallback string)', () => {
    // Le schéma GraphQL marque commit comme nullable. On NE veut PAS un
    // string vide ('') qui s'afficherait à l'écran comme "commit: ".
    const res = new SystemResolver().health();

    expect(res.commit).toBeUndefined();
  });
});
