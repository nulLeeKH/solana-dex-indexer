module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'eslint:recommended',
    'prettier',
  ],
  plugins: ['@typescript-eslint'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  env: {
    node: true,
    es6: true,
  },
  globals: {
    NodeJS: true,
  },
  rules: {
    '@typescript-eslint/no-unused-vars': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-empty-function': 'warn',
    'prefer-const': 'warn',
    'no-console': 'warn',
    'no-unused-vars': 'off',
    'no-useless-catch': 'warn',
    'no-case-declarations': 'warn',
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js'],
};