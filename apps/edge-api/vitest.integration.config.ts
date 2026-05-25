import { defineConfig } from 'vitest/config';

// Config séparée pour les tests d'intégration : ils requièrent Docker
// (testcontainers démarre Postgres + Redis éphémères) et sont lents (~30s
// total), donc on les lance via `pnpm test:integration` et pas dans la
// commande `test` par défaut.
//
// fileParallelism: false — on partage volontairement les containers entre
// fichiers de tests via globalSetup. Paralléliser exigerait soit plusieurs
// instances de containers (coûteux), soit une stratégie de namespacing
// (préfixe email/workspace par worker). Pour Jour-1, séquentiel est plus
// simple et reste rapide.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.spec.ts'],
    globals: false,
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000, // démarrage Postgres + Redis en CI sans cache d'image
    globalSetup: ['./test/integration/global-setup.ts'],
  },
  esbuild: {
    target: 'es2022',
  },
});
