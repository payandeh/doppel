const quote = (files) => files.map((f) => JSON.stringify(f)).join(' ');

export default {
  '*.{js,mjs}': (files) => [
    `eslint --fix --max-warnings=0 ${quote(files)}`,
    `prettier --write ${quote(files)}`,
    ...(files.some((f) => f.endsWith('content/inject.js')) ? ['node tools/ignore-list.mjs'] : [])
  ],
  '*.{json,md,yml,yaml,html,css}': (files) => `prettier --write ${quote(files)}`
};
