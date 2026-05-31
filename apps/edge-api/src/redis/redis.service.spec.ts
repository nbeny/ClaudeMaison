import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis avant import du SUT. Le constructeur de RedisService crée
// `new Redis(url, opts)` ; on capture l'URL, les options, et on simule la
// surface utilisée (ping, quit, on).

let lastUrl: string | undefined;
let lastOpts: Record<string, unknown> | undefined;

const mockClient = {
  ping: vi.fn(),
  quit: vi.fn(),
  on: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: vi.fn((url: string, opts: Record<string, unknown>) => {
    lastUrl = url;
    lastOpts = opts;
    return mockClient;
  }),
}));

import type { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

function configFor(url: string): ConfigService {
  return {
    get: vi.fn((key: string) => (key === 'REDIS_URL' ? url : undefined)),
  } as unknown as ConfigService;
}

// RedisService est le wrapper lifecycle ioredis. Les invariants critiques
// sont les options de connexion (qui affectent la résilience) et le
// contrat de ping/quit. Les valeurs sont en dur dans le constructeur
// parce qu'elles encodent un choix d'ops (3 retries, ready-check actif,
// connect au boot).

describe('RedisService', () => {
  beforeEach(() => {
    lastUrl = undefined;
    lastOpts = undefined;
    mockClient.ping.mockReset();
    mockClient.quit.mockReset();
    mockClient.on.mockReset();
  });

  describe('construction', () => {
    it('passe REDIS_URL à ioredis', () => {
      new RedisService(configFor('redis://localhost:6379'));

      expect(lastUrl).toBe('redis://localhost:6379');
    });

    it('connecte immédiatement au boot (lazyConnect: false)', () => {
      new RedisService(configFor('redis://x:6379'));

      expect(lastOpts?.lazyConnect).toBe(false);
    });

    it('maxRetriesPerRequest = 3 (résilience aux flaps réseau)', () => {
      new RedisService(configFor('redis://x:6379'));

      expect(lastOpts?.maxRetriesPerRequest).toBe(3);
    });

    it('enableReadyCheck = true (anti-PING-avant-INFO)', () => {
      new RedisService(configFor('redis://x:6379'));

      expect(lastOpts?.enableReadyCheck).toBe(true);
    });

    it('handler `error` attaché pour ne pas crasher le process', () => {
      new RedisService(configFor('redis://x:6379'));

      expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('expose client en readonly', () => {
      const svc = new RedisService(configFor('redis://x:6379'));

      expect(svc.client).toBe(mockClient);
    });
  });

  describe('ping', () => {
    it('résout sans erreur quand la réponse est "PONG"', async () => {
      const svc = new RedisService(configFor('redis://x:6379'));
      mockClient.ping.mockResolvedValue('PONG');

      await expect(svc.ping()).resolves.toBeUndefined();
    });

    it('jette quand la réponse n\'est PAS "PONG" (fail-loud)', async () => {
      const svc = new RedisService(configFor('redis://x:6379'));
      mockClient.ping.mockResolvedValue('UNEXPECTED');

      await expect(svc.ping()).rejects.toThrow(/UNEXPECTED/);
    });

    it('jette sur réponse vide (fail-closed)', async () => {
      const svc = new RedisService(configFor('redis://x:6379'));
      mockClient.ping.mockResolvedValue('');

      await expect(svc.ping()).rejects.toThrow(/Redis ping inattendu/);
    });

    it('propage l\'erreur si client.ping rejette', async () => {
      const svc = new RedisService(configFor('redis://x:6379'));
      mockClient.ping.mockRejectedValue(new Error('connection refused'));

      await expect(svc.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('onModuleDestroy', () => {
    it('appelle client.quit (fermeture propre, pas disconnect)', async () => {
      const svc = new RedisService(configFor('redis://x:6379'));
      mockClient.quit.mockResolvedValue('OK');

      await svc.onModuleDestroy();

      expect(mockClient.quit).toHaveBeenCalledTimes(1);
    });
  });
});
