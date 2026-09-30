export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      ['content', 'devtools', 'editor', 'popup', 'manager', 'panel', 'folder', 'ui', 'deps', 'ci', 'release', 'docs']
    ],
    'body-max-line-length': [1, 'always', 120]
  }
};
