import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests des route handlers Next.js : on les exerce comme de simples
// fonctions `POST(req)` / `GET(req)` retournant une `Response`. Pas
// besoin d'un serveur Next.js réel ni du runtime edge — environnement
// node suffit.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    globals: false,
  },
});
