import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '../../../redis/redis.service';
import { OidcStateStore, type OidcStateData } from './oidc-state.store';

/**
 * Faux Redis minimal qui implémente uniquement SET NX EX et GETDEL,
 * suffisant pour tester la sémantique du store. Permet d'éviter
 * Testcontainers pour ce niveau de test.
 */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();

  set = vi.fn(
    async (key: string, value: string, _ex: 'EX', ttlSeconds: number, _nx: 'NX') => {
      this.cleanup();
      if (this.store.has(key)) return null;
      this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return 'OK';
    },
  );

  getdel = vi.fn(async (key: string) => {
    this.cleanup();
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    return entry.value;
  });

  private cleanup() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }
}

function makeStore(): { store: OidcStateStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  const store = new OidcStateStore({ client: redis } as unknown as RedisService);
  return { store, redis };
}

const sample: OidcStateData = {
  codeVerifier: 'verifier-abc',
  nonce: 'nonce-xyz',
  returnTo: 'http://localhost:3001/callback',
  createdAt: 1_700_000_000_000,
};

describe('OidcStateStore', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('put → consume round-trip', async () => {
    const { store } = makeStore();
    await store.put('state-1', sample);
    const restored = await store.consume('state-1');
    expect(restored).toEqual(sample);
  });

  it('consume une seule fois (one-shot)', async () => {
    const { store } = makeStore();
    await store.put('state-1', sample);
    expect(await store.consume('state-1')).toEqual(sample);
    expect(await store.consume('state-1')).toBeNull();
  });

  it('consume sur state inconnu retourne null', async () => {
    const { store } = makeStore();
    expect(await store.consume('jamais-vu')).toBeNull();
  });

  it('put refuse une collision sur le même state', async () => {
    const { store } = makeStore();
    await store.put('state-1', sample);
    await expect(store.put('state-1', sample)).rejects.toThrow(/Collision/);
  });

  it('passe TTL=600 (10 min) et flag NX à SET', async () => {
    const { store, redis } = makeStore();
    await store.put('state-1', sample);
    expect(redis.set).toHaveBeenCalledWith(
      'oidc:state:state-1',
      expect.any(String),
      'EX',
      600,
      'NX',
    );
  });
});
