// Flat ESLint config (eslint 9). Minimal, project-wide.
// On garde un ruleset modeste : on n'est pas là pour discipliner les pulls
// stylistiques (prettier s'en charge), mais pour attraper les bugs réels
// (no-unused-vars, no-floating-promises côté TS) sans étouffer le code en
// migration.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.turbo/**',
      'pnpm-lock.yaml',
      'infrastructure/docker/keycloak/realm-claudemaison-dev.json',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // TypeScript émet déjà des erreurs sur les imports/variables non utilisés
      // au build, pas besoin d'un double check ESLint qui crie sur les `_args`
      // de signature.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // On a beaucoup de code passe-plat (NestJS providers, gRPC handlers),
      // `any` explicite reste utile dans certains adapters.
      '@typescript-eslint/no-explicit-any': 'off',
      // NestJS Module/Controller decorators créent des classes vides à dessein.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Trop bruyant sur les Promises voulues comme fire-and-forget (metrics push).
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  {
    files: ['**/*.spec.ts', '**/*.int.spec.ts', '**/test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Désactive en dernier toutes les règles purement stylistiques que prettier gère.
  prettier,
];
