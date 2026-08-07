// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Lint config focused on real bugs and dead code, not style.
 *
 * Dead-code coverage:
 *   - Unused locals/imports/params           → @typescript-eslint/no-unused-vars (with `^_` opt-out)
 *   - Unused private class members           → no-unused-private-class-members
 *   - Unused exports across modules / files  → knip (run `npm run dead`)
 *   - Unused npm dependencies                → knip
 *
 * We use `recommended-type-checked`, NOT `strict-type-checked` or `stylistic-*`. The strict
 * preset adds rules like `@typescript-eslint/no-unnecessary-type-assertion`,
 * `@typescript-eslint/dot-notation`, `array-type`, `use-unknown-in-catch-callback-variable`,
 * etc. — those are style preferences disguised as bug rules. Many flag valid, intentional
 * code in this project (e.g., bracket access where TS strict-mode requires it).
 *
 * Underscore prefix on a parameter or local opts out of unused-detection ("intentionally
 * unused, kept for documentation"). This matches the TypeScript convention.
 */
export default tseslint.config(
  {
    // `src/__tests__/tmp/**` is test scratch (fake HOMEs, bare git repos) — thousands of
    // files ESLint would walk, and which a concurrent test run deletes mid-walk (ENOENT).
    ignores: [
      'dist/**', 'node_modules/**', 'coverage/**', 'src/__tests__/tmp/**',
      'vitest.config.ts', 'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Test files and config files aren't in `tsconfig.json`'s include (tests are kept
        // out of `dist/`). `tsconfig.eslint.json` is a wider config that covers everything
        // ESLint should lint, without affecting the build.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Dead-code rules — strict.
      'no-unused-private-class-members': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // Real-bug rules we keep on.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Style nags / false positives — turned off. These flag valid intentional code:
      // - `as` casts that document intent without changing types (no-unnecessary-type-assertion)
      // - throws that don't chain `cause` (preserve-caught-error) — message is enough
      // - async methods forced by an interface contract that have no await (require-await)
      // - destructured free functions from node modules wrongly flagged as unbound methods
      // - flag-with-default-false patterns where TS forces the initializer (no-useless-assignment)
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // Tests can be looser — fewer guarantees expected from test scaffolding.
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },
)
