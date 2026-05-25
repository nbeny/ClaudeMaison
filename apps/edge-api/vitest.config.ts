import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Les tests d'intégration ont leur propre config (vitest.integration.config.ts)
    // : ils requièrent testcontainers et leur globalSetup. Sans cette exclusion,
    // ils sont collectés ici aussi et échouent faute de DATABASE_URL.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    globals: false,
    pool: 'forks', // @node-rs/argon2 est un binding natif — workers tsx OK seulement en forks
  },
  esbuild: {
    target: 'es2022',
  },
});
