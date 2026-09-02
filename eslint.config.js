// Flat config (ESLint 10). Layered narrowest-last: base JS -> typed TS ->
// per-area relaxations -> prettier compat, which must stay last so it can turn
// off stylistic rules the earlier layers switched on.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'drizzle/**', 'node_modules/**', '*.min.js'],
  },

  js.configs.recommended,

  // Type-aware linting. `projectService` lets typescript-eslint resolve each
  // file's tsconfig automatically instead of us maintaining a project list.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args prefixed with _ are intentional (Fastify handler signatures).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Enforce `import type` so the emit stays side-effect free under
      // verbatimModuleSyntax.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A floating promise in a request handler is a silently dropped error.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Deliberate escape hatch, but it must be justified in a comment.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            'Use the undici-backed HTTP client in src/banking/http.ts so retries and timeouts apply.',
        },
      ],
    },
  },

  // Plain JS (this config file included) is outside the tsconfig project, so
  // type-aware rules cannot run on it and must be switched off explicitly.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Fastify route plugins must match FastifyPluginAsync's signature, which is
  // async by contract even when a given plugin has nothing to await.
  {
    files: ['src/modules/**/routes.ts', 'src/plugins/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // Config files run in Node before the app's conventions apply.
  {
    files: ['*.config.{ts,js}', 'drizzle.config.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Tests intentionally build partial fixtures and poke at internals.
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  prettier,
);
