import { HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';

// HealthController est l'endpoint /ready exposé aux probes Kubernetes /
// load-balancer. Le contrat est fail-loud : si Postgres OU Redis ping
// fail, on renvoie 503 SERVICE_UNAVAILABLE. Cette logique est ce qui
// permet à un orchestrateur de retirer l'instance du pool de routage,
// donc un bug ici → trafic envoyé vers une instance cassée.
//
// Invariants critiques :
//
//   - readiness fait les deux pings EN PARALLÈLE (Promise.all). Sans
//     ça, un postgres ping qui timeout retarderait le check redis et
//     vice versa, doublant la latence de la probe.
//
//   - readiness ne re-throw PAS les erreurs internes — chaque ping est
//     enrobé d'un .catch qui mappe l'erreur en 'fail'. Sinon la probe
//     ne reçoit pas le payload `checks` détaillé qui sert au debug.
//
//   - readiness throw une HttpException(503) DÈS QU'UN ping échoue
//     (OR logique). Un AND donnerait des faux green quand une seule
//     dépendance est down.
//
//   - liveness ne dépend PAS des deps externes. C'est intentionnel :
//     liveness = "le process est vivant", readiness = "le process peut
//     servir du trafic". Confondre les deux fait redémarrer le pod
//     quand seule la DB est tombée.

function makeController(opts: {
  dbPing?: () => Promise<void>;
  redisPing?: () => Promise<void>;
}): {
  controller: HealthController;
  dbPing: ReturnType<typeof vi.fn>;
  redisPing: ReturnType<typeof vi.fn>;
} {
  const dbPing = vi.fn(opts.dbPing ?? (() => Promise.resolve()));
  const redisPing = vi.fn(opts.redisPing ?? (() => Promise.resolve()));
  const controller = new HealthController(
    { ping: dbPing } as never,
    { ping: redisPing } as never,
  );
  return { controller, dbPing, redisPing };
}

describe('HealthController', () => {
  beforeEach(() => {
    delete process.env.GIT_COMMIT;
    delete process.env.npm_package_version;
  });

  describe('liveness', () => {
    it('renvoie status:ok sans dépendre des deps externes', () => {
      const { controller, dbPing, redisPing } = makeController({});

      const res = controller.liveness();

      expect(res.status).toBe('ok');
      expect(dbPing).not.toHaveBeenCalled();
      expect(redisPing).not.toHaveBeenCalled();
    });

    it('inclut uptime, timestamp, version dans le payload', () => {
      const { controller } = makeController({});

      const res = controller.liveness();

      expect(res.uptime).toBeTypeOf('number');
      expect(res.uptime).toBeGreaterThanOrEqual(0);
      expect(res.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(res.version).toBe('0.0.1'); // fallback quand npm_package_version absent
    });

    it('utilise GIT_COMMIT et npm_package_version quand présents', () => {
      process.env.GIT_COMMIT = 'abc123';
      process.env.npm_package_version = '9.9.9';
      const { controller } = makeController({});

      const res = controller.liveness();

      expect(res.commit).toBe('abc123');
      expect(res.version).toBe('9.9.9');
    });
  });

  describe('readiness — happy path', () => {
    it('appelle db.ping et redis.ping', async () => {
      const { controller, dbPing, redisPing } = makeController({});

      await controller.readiness();

      expect(dbPing).toHaveBeenCalledTimes(1);
      expect(redisPing).toHaveBeenCalledTimes(1);
    });

    it('renvoie 200 avec checks={postgres:ok, redis:ok} quand tout va bien', async () => {
      const { controller } = makeController({});

      const res = await controller.readiness();

      expect(res.status).toBe('ok');
      expect(res.checks).toEqual({ postgres: 'ok', redis: 'ok' });
    });

    it('lance les deux pings en parallèle (Promise.all, pas séquentiel)', async () => {
      // Sans Promise.all, le 2e ping ne démarrerait qu'après que le 1er
      // résolve. Avec Promise.all, les deux démarrent immédiatement.
      let dbStarted = 0;
      let redisStarted = 0;
      let order: string[] = [];
      const { controller } = makeController({
        dbPing: async () => {
          dbStarted = Date.now();
          order.push('db-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('db-end');
        },
        redisPing: async () => {
          redisStarted = Date.now();
          order.push('redis-start');
          await new Promise((r) => setTimeout(r, 10));
          order.push('redis-end');
        },
      });

      await controller.readiness();

      // Les deux starts arrivent avant les ends (parallélisme)
      expect(order.slice(0, 2).sort()).toEqual(['db-start', 'redis-start']);
      expect(Math.abs(dbStarted - redisStarted)).toBeLessThan(5);
    });
  });

  describe('readiness — fail-loud sur dep down', () => {
    it('postgres down → 503 avec postgres:fail, redis:ok', async () => {
      const { controller } = makeController({
        dbPing: () => Promise.reject(new Error('pg refused')),
      });

      await expect(controller.readiness()).rejects.toThrow(HttpException);
      try {
        await controller.readiness();
        expect.fail('readiness aurait dû throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = httpErr.getResponse() as {
          status: string;
          checks: { postgres: string; redis: string };
        };
        expect(body.status).toBe('fail');
        expect(body.checks).toEqual({ postgres: 'fail', redis: 'ok' });
      }
    });

    it('redis down → 503 avec postgres:ok, redis:fail', async () => {
      const { controller } = makeController({
        redisPing: () => Promise.reject(new Error('redis refused')),
      });

      try {
        await controller.readiness();
        expect.fail('readiness aurait dû throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        const body = httpErr.getResponse() as {
          checks: { postgres: string; redis: string };
        };
        expect(body.checks).toEqual({ postgres: 'ok', redis: 'fail' });
      }
    });

    it('les deux down → 503 avec les deux :fail (OR, pas AND)', async () => {
      const { controller } = makeController({
        dbPing: () => Promise.reject(new Error('pg refused')),
        redisPing: () => Promise.reject(new Error('redis refused')),
      });

      try {
        await controller.readiness();
        expect.fail('readiness aurait dû throw');
      } catch (err) {
        const httpErr = err as HttpException;
        const body = httpErr.getResponse() as {
          checks: { postgres: string; redis: string };
        };
        expect(body.checks).toEqual({ postgres: 'fail', redis: 'fail' });
      }
    });

    it('postgres down → on attend QUAND MÊME redis (pas de short-circuit)', async () => {
      // Vérifie qu'on ne perd pas le résultat de redis quand pg fail.
      // Un implémenteur tenté par try/catch enveloppant Promise.all
      // perdrait redisPing.
      const { controller, redisPing } = makeController({
        dbPing: () => Promise.reject(new Error('pg down')),
      });

      try {
        await controller.readiness();
      } catch {
        /* attendu */
      }

      expect(redisPing).toHaveBeenCalledTimes(1);
    });

    it('ne re-throw PAS l\'erreur interne — wrap dans HttpException 503', async () => {
      const { controller } = makeController({
        dbPing: () => Promise.reject(new Error('SUPER SECRET INTERNAL ERROR')),
      });

      try {
        await controller.readiness();
        expect.fail('readiness aurait dû throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        // Le message brut de l'erreur NE doit PAS fuiter dans la response
        const body = (err as HttpException).getResponse();
        expect(JSON.stringify(body)).not.toContain('SUPER SECRET INTERNAL ERROR');
      }
    });
  });
});
