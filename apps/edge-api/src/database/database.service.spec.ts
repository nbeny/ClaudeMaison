import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock postgres avant import du SUT. Le constructeur appelle
// `postgres(url, opts)` une fois ; on capture l'URL et les options.

let lastUrl: string | undefined;
let lastOpts: Record<string, unknown> | undefined;

const mockSql = vi.fn();
const mockEnd = vi.fn();
Object.assign(mockSql, { end: mockEnd });

vi.mock('postgres', () => {
  return {
    default: vi.fn((url: string, opts: Record<string, unknown>) => {
      lastUrl = url;
      lastOpts = opts;
      return mockSql;
    }),
  };
});

import type { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service';

function configFor(url: string): ConfigService {
  return {
    get: vi.fn((key: string) => (key === 'DATABASE_URL' ? url : undefined)),
  } as unknown as ConfigService;
}

// DatabaseService est le wrapper postgres.js. Les options de pool encodent
// des choix d'ops critiques : `max: 10` plafonne les connexions pour ne pas
// noyer Postgres ; `prepare: true` active les prepared statements (perf et
// anti-injection par construction) ; les timeouts évitent les hangs. Une
// modification silencieuse de ces valeurs (ex: max=100 « pour aller plus
// vite ») peut tuer la DB sous charge.

describe('DatabaseService', () => {
  beforeEach(() => {
    lastUrl = undefined;
    lastOpts = undefined;
    mockSql.mockReset();
    mockEnd.mockReset();
    // mockSql perd .end après reset — réattache
    Object.assign(mockSql, { end: mockEnd });
  });

  describe('construction', () => {
    it('passe DATABASE_URL à postgres', () => {
      new DatabaseService(configFor('postgres://u:p@h:5432/db'));

      expect(lastUrl).toBe('postgres://u:p@h:5432/db');
    });

    it('max: 10 (plafond connexions, anti-noyage DB)', () => {
      new DatabaseService(configFor('postgres://h/db'));

      expect(lastOpts?.max).toBe(10);
    });

    it('idle_timeout: 30 (libération connexion inactive en secondes)', () => {
      new DatabaseService(configFor('postgres://h/db'));

      expect(lastOpts?.idle_timeout).toBe(30);
    });

    it('connect_timeout: 5 (anti-hang au démarrage)', () => {
      new DatabaseService(configFor('postgres://h/db'));

      expect(lastOpts?.connect_timeout).toBe(5);
    });

    it('prepare: true (prepared statements actifs)', () => {
      new DatabaseService(configFor('postgres://h/db'));

      expect(lastOpts?.prepare).toBe(true);
    });

    it('expose sql en readonly', () => {
      const svc = new DatabaseService(configFor('postgres://h/db'));

      expect(svc.sql).toBe(mockSql);
    });
  });

  describe('ping', () => {
    it('appelle `SELECT 1` via tagged template', async () => {
      const svc = new DatabaseService(configFor('postgres://h/db'));
      mockSql.mockResolvedValue([{ '?column?': 1 }]);

      await svc.ping();

      expect(mockSql).toHaveBeenCalledTimes(1);
      const strings = mockSql.mock.calls[0]![0] as TemplateStringsArray;
      expect(strings.join('')).toBe('SELECT 1');
    });

    it('propage l\'erreur si la query rejette', async () => {
      const svc = new DatabaseService(configFor('postgres://h/db'));
      mockSql.mockRejectedValue(new Error('connection refused'));

      await expect(svc.ping()).rejects.toThrow('connection refused');
    });
  });

  describe('onModuleDestroy', () => {
    it('appelle sql.end({ timeout: 5 }) (drain gracieux 5s max)', async () => {
      const svc = new DatabaseService(configFor('postgres://h/db'));
      mockEnd.mockResolvedValue(undefined);

      await svc.onModuleDestroy();

      expect(mockEnd).toHaveBeenCalledTimes(1);
      expect(mockEnd).toHaveBeenCalledWith({ timeout: 5 });
    });
  });
});
