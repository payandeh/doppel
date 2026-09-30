import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadScript(relPaths, exportName) {
  const ctx = vm.createContext({ globalThis: {}, console });
  ctx.globalThis = ctx;
  for (const relPath of [].concat(relPaths))
    vm.runInContext(readFileSync(new URL('../../' + relPath, import.meta.url), 'utf8'), ctx);
  vm.runInContext(
    `globalThis.__export = typeof ${exportName} !== 'undefined' ? ${exportName} : globalThis.${exportName};`,
    ctx
  );
  return ctx.__export;
}
