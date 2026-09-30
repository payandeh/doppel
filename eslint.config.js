import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

const shared = {
  APIOV: 'readonly',
  APIOV_MATCH: 'readonly',
  APIOV_TREE: 'readonly',
  JsonCheck: 'readonly',
  JsonEditor: 'readonly',
  FolderSync: 'readonly',
  openRuleEditor: 'readonly',
  mountRulesView: 'readonly'
};

export default [
  { ignores: ['node_modules/', 'dist/', 'lib/vendor/'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none', argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }]
    }
  },
  {
    files: ['*.js', 'lib/**/*.js', 'content/**/*.js'],
    ignores: ['*.config.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...shared }
    }
  },
  {
    files: ['background.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions, ...shared } }
  },
  {
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', '*.config.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-console': 'off' }
  },
  {
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: 'readonly', APIOV: 'readonly' } }
  },
  prettier
];
