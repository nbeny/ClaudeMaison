import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

// `loadEnv` côté realtime est le point d'entrée fail-closed du process. Le
// service est petit (Fastify nu, pas de @nestjs/config), donc une seule
// passe Zod au boot ; ensuite tout consomme `env: Env` typé.
//
// Invariants critiques verrouillés :
//
//   - JWT_SIGNING_KEY min(32) : doit matcher le secret partagé avec edge-api.
//     Un secret court fait tomber la signature HS256 sous attaque GPU.
//
//   - INTERNAL_SHARED_SECRET min(32) ET sans défaut : c'est le header
//     `x-internal-secret` qui prouve que realtime parle à edge-api en
//     tant que service interne. Sans défaut → impossible de démarrer
//     avec un secret vide en dev/test, ce qui éviterait un déploiement
//     prod où l'opérateur a « oublié » de le définir.
//
//   - KEYCLOAK_ISSUER_URL optionnel mais URL stricte si présent. C'est ce
//     qui active le dual-mode (HS256 edge-api + RS256 Keycloak). Une URL
//     malformée ferait planter la résolution JWKS à la 1re requête.
//
//   - HTTP_PORT coerce + positive int (3100 défaut, plage Fastify dev).
//
//   - EDGE_API_INTERNAL_URL URL avec défaut `http://edge-api:3000` (nom
//     de service docker-compose). En dev local sans compose, l'opérateur
//     doit pouvoir override sans toucher au code.
//
//   - Message d'erreur : `Invalid environment for realtime:\n  …` agrège
//     toutes les fautes, lisible dans les logs de crash.

const VALID_KEY = 'k'.repeat(32);
const VALID_SECRET = 's'.repeat(32);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    JWT_SIGNING_KEY: VALID_KEY,
    INTERNAL_SHARED_SECRET: VALID_SECRET,
  };
}

describe('realtime loadEnv', () => {
  describe('configuration minimale + défauts', () => {
    it('accepte un env minimal et applique les défauts docker-friendly', () => {
      const env = loadEnv(baseEnv());

      expect(env.NODE_ENV).toBe('development');
      expect(env.HTTP_PORT).toBe(3100);
      expect(env.HTTP_HOST).toBe('0.0.0.0');
      expect(env.LOG_LEVEL).toBe('info');
      expect(env.JWT_ISSUER).toBe('claudemaison-edge-api');
      expect(env.JWT_AUDIENCE).toBe('claudemaison-clients');
      expect(env.NATS_URL).toBe('nats://localhost:4222');
      expect(env.NATS_STREAM).toBe('events');
      expect(env.OTEL_SERVICE_NAME).toBe('realtime');
      expect(env.EDGE_API_INTERNAL_URL).toBe('http://edge-api:3000');
    });

    it('NODE_ENV honoré quand fourni', () => {
      const env = loadEnv({ ...baseEnv(), NODE_ENV: 'production' });
      expect(env.NODE_ENV).toBe('production');
    });

    it('rejette NODE_ENV inconnu', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), NODE_ENV: 'staging' }),
      ).toThrow(/NODE_ENV/);
    });

    it('LOG_LEVEL enum strict', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), LOG_LEVEL: 'verbose' }),
      ).toThrow(/LOG_LEVEL/);
    });
  });

  describe('secrets — anti-faible', () => {
    it('rejette JWT_SIGNING_KEY absent', () => {
      const env = baseEnv();
      delete env.JWT_SIGNING_KEY;
      expect(() => loadEnv(env)).toThrow(/JWT_SIGNING_KEY/);
    });

    it('rejette JWT_SIGNING_KEY < 32 caractères', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'short' }),
      ).toThrow(/JWT_SIGNING_KEY/);
    });

    it('rejette JWT_SIGNING_KEY à 31 caractères (borne)', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'x'.repeat(31) }),
      ).toThrow(/JWT_SIGNING_KEY/);
    });

    it('accepte JWT_SIGNING_KEY exactement à 32 caractères', () => {
      const env = loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'x'.repeat(32) });
      expect(env.JWT_SIGNING_KEY).toHaveLength(32);
    });

    it('rejette INTERNAL_SHARED_SECRET absent (pas de défaut)', () => {
      const env = baseEnv();
      delete env.INTERNAL_SHARED_SECRET;
      expect(() => loadEnv(env)).toThrow(/INTERNAL_SHARED_SECRET/);
    });

    it('rejette INTERNAL_SHARED_SECRET < 32 caractères', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), INTERNAL_SHARED_SECRET: 'weak' }),
      ).toThrow(/INTERNAL_SHARED_SECRET/);
    });
  });

  describe('HTTP_PORT — coerce positive int', () => {
    it('string → int', () => {
      const env = loadEnv({ ...baseEnv(), HTTP_PORT: '4500' });
      expect(env.HTTP_PORT).toBe(4500);
      expect(typeof env.HTTP_PORT).toBe('number');
    });

    it('rejette HTTP_PORT négatif', () => {
      expect(() => loadEnv({ ...baseEnv(), HTTP_PORT: '-1' })).toThrow(
        /HTTP_PORT/,
      );
    });

    it('rejette HTTP_PORT zéro', () => {
      expect(() => loadEnv({ ...baseEnv(), HTTP_PORT: '0' })).toThrow(
        /HTTP_PORT/,
      );
    });

    it('rejette HTTP_PORT non entier', () => {
      expect(() => loadEnv({ ...baseEnv(), HTTP_PORT: '3.14' })).toThrow(
        /HTTP_PORT/,
      );
    });
  });

  describe('EDGE_API_INTERNAL_URL — URL stricte avec défaut docker', () => {
    it('défaut pointe sur le service docker-compose', () => {
      const env = loadEnv(baseEnv());
      expect(env.EDGE_API_INTERNAL_URL).toBe('http://edge-api:3000');
    });

    it('override accepté quand URL valide', () => {
      const env = loadEnv({
        ...baseEnv(),
        EDGE_API_INTERNAL_URL: 'http://localhost:3000',
      });
      expect(env.EDGE_API_INTERNAL_URL).toBe('http://localhost:3000');
    });

    it('rejette EDGE_API_INTERNAL_URL non-URL', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), EDGE_API_INTERNAL_URL: 'not-a-url' }),
      ).toThrow(/EDGE_API_INTERNAL_URL/);
    });
  });

  describe('KEYCLOAK_ISSUER_URL — optionnel mais URL stricte si présent', () => {
    it('absent accepté (mode HS256-only)', () => {
      const env = loadEnv(baseEnv());
      expect(env.KEYCLOAK_ISSUER_URL).toBeUndefined();
    });

    it('URL valide active le dual-mode', () => {
      const env = loadEnv({
        ...baseEnv(),
        KEYCLOAK_ISSUER_URL: 'http://keycloak:8080/realms/cm-dev',
      });
      expect(env.KEYCLOAK_ISSUER_URL).toBe(
        'http://keycloak:8080/realms/cm-dev',
      );
    });

    it('rejette KEYCLOAK_ISSUER_URL malformée', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), KEYCLOAK_ISSUER_URL: 'keycloak-without-scheme' }),
      ).toThrow(/KEYCLOAK_ISSUER_URL/);
    });
  });

  describe('NATS — défauts dev', () => {
    it('NATS_URL défaut localhost', () => {
      const env = loadEnv(baseEnv());
      expect(env.NATS_URL).toBe('nats://localhost:4222');
    });

    it('NATS_STREAM défaut "events"', () => {
      const env = loadEnv(baseEnv());
      expect(env.NATS_STREAM).toBe('events');
    });

    it('override NATS_URL accepté (pas de URL strict)', () => {
      const env = loadEnv({
        ...baseEnv(),
        NATS_URL: 'nats://prod-cluster:4222',
      });
      expect(env.NATS_URL).toBe('nats://prod-cluster:4222');
    });
  });

  describe('JWT_ISSUER/AUDIENCE — défauts matchent edge-api', () => {
    it('JWT_ISSUER défaut "claudemaison-edge-api"', () => {
      const env = loadEnv(baseEnv());
      expect(env.JWT_ISSUER).toBe('claudemaison-edge-api');
    });

    it('JWT_AUDIENCE défaut "claudemaison-clients"', () => {
      const env = loadEnv(baseEnv());
      expect(env.JWT_AUDIENCE).toBe('claudemaison-clients');
    });

    it('override accepté', () => {
      const env = loadEnv({
        ...baseEnv(),
        JWT_ISSUER: 'custom-issuer',
        JWT_AUDIENCE: 'custom-aud',
      });
      expect(env.JWT_ISSUER).toBe('custom-issuer');
      expect(env.JWT_AUDIENCE).toBe('custom-aud');
    });
  });

  describe('message d\'erreur — lisible par les ops', () => {
    it('préfixe "Invalid environment for realtime:"', () => {
      let msg = '';
      try {
        loadEnv({});
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/Invalid environment for realtime:/);
    });

    it('agrège plusieurs fautes (pas fail-fast)', () => {
      let msg = '';
      try {
        loadEnv({
          JWT_SIGNING_KEY: 'short',
          INTERNAL_SHARED_SECRET: 'weak',
        });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/JWT_SIGNING_KEY/);
      expect(msg).toMatch(/INTERNAL_SHARED_SECRET/);
    });
  });
});
