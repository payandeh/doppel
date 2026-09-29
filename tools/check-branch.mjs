import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'hotfix',
  'release'
];
const PATTERN = new RegExp(`^(${TYPES.join('|')})/[a-z0-9]+(?:[._-][a-z0-9]+)*$`);
const BOTS = /^(dependabot|release-please--|coderabbitai|renovate)\b/;
const PROTECTED = ['main'];

function problem(name) {
  if (PROTECTED.includes(name)) return `"${name}" is protected. Create a branch and open a pull request.`;
  if (BOTS.test(name) || PATTERN.test(name)) return null;
  return `Branch "${name}" doesn't follow the naming convention.`;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  console.error(`  Use <type>/<short-description> in lowercase kebab-case, for example:`);
  console.error(`    feat/import-har-files   fix/xhr-timeout   docs/readme-install\n`);
  console.error(`  Types: ${TYPES.join(', ')}`);
  console.error(`  Rename the current branch with: git branch -m <new-name>\n`);
  process.exit(1);
}

const mode = process.argv[2];
let names = [];

if (mode === '--name') {
  names = [process.argv[3]];
} else if (mode === '--pre-push') {
  const input = readFileSync(0, 'utf8').trim();
  names = input
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ')[2])
    .filter((ref) => ref && ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length));
} else {
  const current = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  if (current) names = [current];
}

for (const name of names) {
  const message = problem(name);
  if (message) fail(message);
}
