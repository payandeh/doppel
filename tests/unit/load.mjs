// Loads the extension's plain (non-module) scripts into a sandbox for testing.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadScript(relPath, exportName) {
  const src = readFileSync(new URL('../../' + relPath, import.meta.url), 'utf8');
  const ctx = vm.createContext({ globalThis: {}, console });
  ctx.globalThis = ctx;
  vm.runInContext(src + `\n;globalThis.__export = typeof ${exportName} !== 'undefined' ? ${exportName} : globalThis.${exportName};`, ctx);
  return ctx.__export;
}
