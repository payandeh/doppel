// Static checks: JS syntax, manifest integrity, version sync, inject.js ignore-list map.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const errors = [];
const fail = (msg) => errors.push(msg);

// 1. Every JS file parses
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (['node_modules', '.git', 'dist', 'vendor'].includes(f)) return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const jsFiles = walk(root).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { fail(`Syntax error in ${f.replace(root, '')}:\n${e.stderr}`); }
}

// 2. Manifest references files that exist
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background?.service_worker, manifest.action?.default_popup, manifest.devtools_page, manifest.options_page,
  ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((c) => c.js || [])
].filter(Boolean);
for (const r of refs) if (!existsSync(join(root, r))) fail(`manifest.json references missing file: ${r}`);
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');

// 3. Scripts/styles referenced from HTML pages exist
for (const html of readdirSync(root).filter((f) => f.endsWith('.html'))) {
  const src = readFileSync(join(root, html), 'utf8');
  for (const [, ref] of src.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|png))"/g)) {
    if (!existsSync(join(root, ref))) fail(`${html} references missing file: ${ref}`);
  }
}

// 4. Versions agree
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== manifest.version) fail(`package.json version ${pkg.version} != manifest.json version ${manifest.version}`);

// 5. inject.js keeps its ignore-list source map (run tools/ignore-list.py after editing it)
const inject = readFileSync(join(root, 'content/inject.js'), 'utf8');
const m = inject.match(/\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\s*$/);
if (!m) fail('content/inject.js is missing its ignore-list source map — run: python3 tools/ignore-list.py');
else {
  const map = JSON.parse(Buffer.from(m[1], 'base64').toString());
  const body = inject.slice(0, m.index);
  if (map.sourcesContent?.[0] !== body) fail('content/inject.js changed since its source map was made — run: python3 tools/ignore-list.py');
}

if (errors.length) {
  console.error(errors.map((e) => '✗ ' + e).join('\n'));
  process.exit(1);
}
console.log(`✓ ${jsFiles.length} JS files parse, manifest OK (v${manifest.version}), ${refs.length} references found`);
