import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../content/inject.js', import.meta.url);
const src =
  readFileSync(file, 'utf8')
    .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n')
    .trimEnd() + '\n';
const lines = src.split('\n').length;
const map = {
  version: 3,
  file: 'inject.js',
  sources: ['doppel-internal/inject.js'],
  sourcesContent: [src],
  names: [],
  mappings: ['AAAA', ...Array(lines - 1).fill('AACA')].join(';'),
  x_google_ignoreList: [0]
};
writeFileSync(
  file,
  src +
    '//# sourceMappingURL=data:application/json;base64,' +
    Buffer.from(JSON.stringify(map)).toString('base64') +
    '\n'
);
console.log(`ignore-list map updated (${lines} lines)`);
