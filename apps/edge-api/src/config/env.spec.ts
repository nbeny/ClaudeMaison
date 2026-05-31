import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

// `loadEnv` est le point d'entrée fail-closed du process edge-api : si une
// invariant de config est violée, le process refuse de démarrer. C'est ce qui
// garantit que la prod ne « marche » jamais accidentellement avec un secret
// vide ou un secret faible (anti-régression la plus rentable du repo, parce
// qu'une fuite via JWT_SIGNING_KEY court ne se détecte pas à l'exécution —
// elle ne se voit qu'au pentest, ou au breach).
//
// Invariants critiques verrouillés :
//
//   - JWT_SIGNING_KEY min(32) : tout secret de signature plus court doit
//     refuser le boot. Anti-secret-faible (HS256 < 256 bits est cassable
//     en quelques heures sur du GPU consumer).
//
//   - INTERNAL_SHARED_SECRET min(32) ET pas de défaut : c'est le secret
//     du header `x-internal-secret` qui autorise realtime → edge-api.
//     Sans défaut, on ne peut pas démarrer en dev/test avec un secret
//     vide qui « marcherait » accidentellement en prod.
//
//   - OIDC tout-ou-rien (superRefine) : si l'opérateur fournit
//     OIDC_ISSUER_URL sans CLIENT_ID, le module OIDC démarrerait à moitié
//     configuré et accepterait des callbacks que personne ne peut signer.
//     Le superRefine émet une issue par variable manquante pour que le
//     message d'erreur dise *quoi* manque, pas juste « config invalide ».
//
//   - ALLOWED_ORIGINS : transform split/trim/filter Boolean — un origin
//     vide passé à CORS = bypass implicite, donc on filtre les chaînes
//     vides après split. Un défaut `http://localhost:3001` permet au dev
//     de démarrer sans config.
//
//   - PORT/TTL coerce + positive int : `process.env.*` est toujours une
//     string, donc on coerce et on rejette 0 ou négatif (un TTL négatif
//     rendrait tous les tokens expirés au moment de l'émission).
//
//   - URL stricts : DATABASE_URL, REDIS_URL, AI_CORE_URL — un URL malformé
//     court-circuiterait `new URL()` plus tard et planterait en runtime,
//     mieux vaut planter au boot.
//
//   - Format du message d'erreur : `loadEnv` jette une `Error` dont le
//     message liste les variables fautives avec leur chemin. C'est ce
//     que les ops lisent dans les logs de crash, donc on verrouille la
//     forme.

const VALID_KEY = 'k'.repeat(32);
const VALID_SECRET = 's'.repeat(32);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/edge',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ISSUER: 'claudemaison-edge-api',
    JWT_AUDIENCE: 'claudemaison-web',
    JWT_SIGNING_KEY: VALID_KEY,
    INTERNAL_SHARED_SECRET: VALID_SECRET,
  };
}

describe('loadEnv — invariants fail-closed', () => {
  describe('configuration minimale valide', () => {
    it('accepte un env minimal et applique les défauts', () => {
      const env = loadEnv(baseEnv());

      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(3000);
      expect(env.LOG_LEVEL).toBe('info');
      expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
      expect(env.JWT_REFRESH_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
      expect(env.ALLOWED_ORIGINS).toEqual(['http://localhost:3001']);
      expect(env.OTEL_SERVICE_NAME).toBe('edge-api');
      expect(env.BILLING_GRPC_HOST).toBe('0.0.0.0');
      expect(env.BILLING_GRPC_PORT).toBe(5001);
      expect(env.AI_CORE_URL).toBe('http://ai-core:5001');
    });

    it('NODE_ENV honoré quand fourni', () => {
      const env = loadEnv({ ...baseEnv(), NODE_ENV: 'production' });
      expect(env.NODE_ENV).toBe('production');
    });

    it('LOG_LEVEL honoré quand fourni', () => {
      const env = loadEnv({ ...baseEnv(), LOG_LEVEL: 'debug' });
      expect(env.LOG_LEVEL).toBe('debug');
    });
  });

  describe('secrets — verrou anti-faible', () => {
    it('rejette JWT_SIGNING_KEY de moins de 32 caractères', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'too-short' }),
      ).toThrow(/JWT_SIGNING_KEY/);
    });

    it('rejette JWT_SIGNING_KEY exactement à 31 caractères (borne)', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'x'.repeat(31) }),
      ).toThrow(/JWT_SIGNING_KEY/);
    });

    it('accepte JWT_SIGNING_KEY à exactement 32 caractères', () => {
      const env = loadEnv({ ...baseEnv(), JWT_SIGNING_KEY: 'x'.repeat(32) });
      expect(env.JWT_SIGNING_KEY).toHaveLength(32);
    });

    it('rejette INTERNAL_SHARED_SECRET absent (pas de défaut)', () => {
      const env = baseEnv();
      delete env.INTERNAL_SHARED_SECRET;
      expect(() => loadEnv(env)).toThrow(/INTERNAL_SHARED_SECRET/);
    });

    it('rejette INTERNAL_SHARED_SECRET de moins de 32 caractères', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), INTERNAL_SHARED_SECRET: 'weak' }),
      ).toThrow(/INTERNAL_SHARED_SECRET/);
    });

    it('rejette BILLING_GRPC_TOKEN de moins de 32 caractères quand présent', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), BILLING_GRPC_TOKEN: 'short' }),
      ).toThrow(/BILLING_GRPC_TOKEN/);
    });

    it('accepte BILLING_GRPC_TOKEN absent (gate d\'activation gRPC)', () => {
      const env = loadEnv(baseEnv());
      expect(env.BILLING_GRPC_TOKEN).toBeUndefined();
    });
  });

  describe('champs requis — fail-closed', () => {
    const required = [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'JWT_SIGNING_KEY',
      'INTERNAL_SHARED_SECRET',
    ] as const;

    for (const key of required) {
      it(`rejette ${key} absent`, () => {
        const env = baseEnv();
        delete env[key];
        expect(() => loadEnv(env)).toThrow();
      });
    }

    it('rejette DATABASE_URL non-URL', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), DATABASE_URL: 'not-a-url' }),
      ).toThrow(/DATABASE_URL/);
    });

    it('rejette REDIS_URL non-URL', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), REDIS_URL: 'tcp-without-scheme' }),
      ).toThrow(/REDIS_URL/);
    });

    it('rejette JWT_ISSUER vide', () => {
      expect(() => loadEnv({ ...baseEnv(), JWT_ISSUER: '' })).toThrow(
        /JWT_ISSUER/,
      );
    });

    it('rejette JWT_AUDIENCE vide', () => {
      expect(() => loadEnv({ ...baseEnv(), JWT_AUDIENCE: '' })).toThrow(
        /JWT_AUDIENCE/,
      );
    });
  });

  describe('coerce numérique — anti-string-vs-number', () => {
    it('PORT string → int', () => {
      const env = loadEnv({ ...baseEnv(), PORT: '4500' });
      expect(env.PORT).toBe(4500);
      expect(typeof env.PORT).toBe('number');
    });

    it('rejette PORT négatif', () => {
      expect(() => loadEnv({ ...baseEnv(), PORT: '-1' })).toThrow(/PORT/);
    });

    it('rejette PORT zéro (non positif)', () => {
      expect(() => loadEnv({ ...baseEnv(), PORT: '0' })).toThrow(/PORT/);
    });

    it('rejette PORT non entier', () => {
      expect(() => loadEnv({ ...baseEnv(), PORT: '3.14' })).toThrow(/PORT/);
    });

    it('JWT_ACCESS_TTL_SECONDS coerce et positif requis', () => {
      const env = loadEnv({ ...baseEnv(), JWT_ACCESS_TTL_SECONDS: '600' });
      expect(env.JWT_ACCESS_TTL_SECONDS).toBe(600);
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_ACCESS_TTL_SECONDS: '0' }),
      ).toThrow(/JWT_ACCESS_TTL_SECONDS/);
    });

    it('JWT_REFRESH_TTL_SECONDS coerce et positif requis', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), JWT_REFRESH_TTL_SECONDS: '-1' }),
      ).toThrow(/JWT_REFRESH_TTL_SECONDS/);
    });

    it('BILLING_GRPC_PORT coerce', () => {
      const env = loadEnv({ ...baseEnv(), BILLING_GRPC_PORT: '6001' });
      expect(env.BILLING_GRPC_PORT).toBe(6001);
    });
  });

  describe('ALLOWED_ORIGINS — transform split/trim/filter', () => {
    it('split sur virgule', () => {
      const env = loadEnv({
        ...baseEnv(),
        ALLOWED_ORIGINS: 'http://a.test,http://b.test',
      });
      expect(env.ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    });

    it('trim les espaces autour des origins', () => {
      const env = loadEnv({
        ...baseEnv(),
        ALLOWED_ORIGINS: ' http://a.test , http://b.test ',
      });
      expect(env.ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    });

    it('filtre les chaînes vides — anti-bypass CORS implicite', () => {
      const env = loadEnv({
        ...baseEnv(),
        ALLOWED_ORIGINS: 'http://a.test,,http://b.test,',
      });
      expect(env.ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    });

    it('ALLOWED_ORIGINS = "" → tableau vide après filter', () => {
      const env = loadEnv({ ...baseEnv(), ALLOWED_ORIGINS: '' });
      expect(env.ALLOWED_ORIGINS).toEqual([]);
    });
  });

  describe('OIDC — tout-ou-rien (superRefine)', () => {
    const fullOidc = {
      OIDC_ISSUER_URL: 'https://idp.test/realms/main',
      OIDC_CLIENT_ID: 'edge-api',
      OIDC_CLIENT_SECRET: 'oidc-secret',
      OIDC_REDIRECT_URI: 'https://app.test/oidc/callback',
    };

    it('accepte aucune variable OIDC (mode local-only)', () => {
      const env = loadEnv(baseEnv());
      expect(env.OIDC_ISSUER_URL).toBeUndefined();
      expect(env.OIDC_CLIENT_ID).toBeUndefined();
      expect(env.OIDC_CLIENT_SECRET).toBeUndefined();
      expect(env.OIDC_REDIRECT_URI).toBeUndefined();
    });

    it('accepte les 4 variables OIDC fournies', () => {
      const env = loadEnv({ ...baseEnv(), ...fullOidc });
      expect(env.OIDC_ISSUER_URL).toBe(fullOidc.OIDC_ISSUER_URL);
      expect(env.OIDC_CLIENT_ID).toBe('edge-api');
    });

    it('rejette OIDC partiel : ISSUER seul → 3 issues nommant les manquantes', () => {
      let error: Error | undefined;
      try {
        loadEnv({ ...baseEnv(), OIDC_ISSUER_URL: 'https://idp.test' });
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/OIDC_CLIENT_ID/);
      expect(error!.message).toMatch(/OIDC_CLIENT_SECRET/);
      expect(error!.message).toMatch(/OIDC_REDIRECT_URI/);
    });

    it('rejette OIDC partiel : CLIENT_ID manquant', () => {
      const partial = { ...fullOidc } as Record<string, string | undefined>;
      delete partial.OIDC_CLIENT_ID;
      expect(() => loadEnv({ ...baseEnv(), ...partial })).toThrow(
        /OIDC_CLIENT_ID/,
      );
    });

    it('rejette OIDC partiel : SECRET manquant', () => {
      const partial = { ...fullOidc } as Record<string, string | undefined>;
      delete partial.OIDC_CLIENT_SECRET;
      expect(() => loadEnv({ ...baseEnv(), ...partial })).toThrow(
        /OIDC_CLIENT_SECRET/,
      );
    });

    it('rejette OIDC partiel : REDIRECT_URI manquant', () => {
      const partial = { ...fullOidc } as Record<string, string | undefined>;
      delete partial.OIDC_REDIRECT_URI;
      expect(() => loadEnv({ ...baseEnv(), ...partial })).toThrow(
        /OIDC_REDIRECT_URI/,
      );
    });

    it('OIDC_POST_LOGIN_REDIRECT n\'entre PAS dans le tout-ou-rien', () => {
      const env = loadEnv(baseEnv());
      expect(env.OIDC_POST_LOGIN_REDIRECT).toBeUndefined();
    });

    it('rejette OIDC_ISSUER_URL non-URL', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), ...fullOidc, OIDC_ISSUER_URL: 'not-url' }),
      ).toThrow(/OIDC_ISSUER_URL/);
    });
  });

  describe('AI_CORE_URL — défaut docker-compose', () => {
    it('défaut pointe sur le service docker-compose', () => {
      const env = loadEnv(baseEnv());
      expect(env.AI_CORE_URL).toBe('http://ai-core:5001');
    });

    it('override accepté quand URL valide', () => {
      const env = loadEnv({
        ...baseEnv(),
        AI_CORE_URL: 'http://localhost:5001',
      });
      expect(env.AI_CORE_URL).toBe('http://localhost:5001');
    });

    it('rejette AI_CORE_URL non-URL', () => {
      expect(() =>
        loadEnv({ ...baseEnv(), AI_CORE_URL: 'not-a-url' }),
      ).toThrow(/AI_CORE_URL/);
    });
  });

  describe('message d\'erreur — lisible par les ops', () => {
    it('liste les variables fautives avec leur chemin', () => {
      let msg = '';
      try {
        loadEnv({});
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/Variables d'environnement/);
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/JWT_SIGNING_KEY/);
      expect(msg).toMatch(/INTERNAL_SHARED_SECRET/);
    });

    it('liste plusieurs erreurs en même temps (pas fail-fast)', () => {
      let msg = '';
      try {
        loadEnv({
          ...baseEnv(),
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
