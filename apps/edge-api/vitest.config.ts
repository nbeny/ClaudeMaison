import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globals: false,
    pool: 'forks', // @node-rs/argon2 est un binding natif — workers tsx OK seulement en forks
  },
  esbuild: {
    target: 'es2022',
  },
});
