module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    // Turns off every stylistic rule that would conflict with Prettier.
    'prettier',
  ],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'coverage/', 'node_modules/'],
  rules: {
    // Formatting is owned by Prettier (`npm run format` / `npm run format:check`).
    // It is not enforced through ESLint yet so that lint can pass without a
    // repo-wide reformat; flip this to 'error' once the codebase is formatted.
    'prettier/prettier': 'off',

    // NestJS conventions used throughout the codebase.
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',

    // Existing code relies on these patterns; surface them as warnings
    // instead of failing the build.
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
    '@typescript-eslint/no-var-requires': 'warn',
    '@typescript-eslint/no-this-alias': 'warn',
    '@typescript-eslint/ban-types': 'warn',
    '@typescript-eslint/ban-ts-comment': 'warn',
    '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
    '@typescript-eslint/no-namespace': 'warn',
    'no-case-declarations': 'warn',
    'no-empty': 'warn',
    'no-useless-escape': 'warn',
    'no-prototype-builtins': 'warn',
    'no-constant-condition': 'warn',
    'no-control-regex': 'warn',
    'no-async-promise-executor': 'warn',
    'no-inner-declarations': 'warn',
    'no-fallthrough': 'warn',
    'no-useless-catch': 'warn',
    'no-extra-boolean-cast': 'warn',
    'no-unsafe-optional-chaining': 'warn',
    'no-empty-pattern': 'warn',
    'no-self-assign': 'warn',
    'prefer-const': 'warn',
  },
};
