// Launches Chromium with Doppel loaded and serves a small test API.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = new URL('../../', import.meta.url).pathname;

export async function launch() {
  const opts = {
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  };
  // Extensions need full Chromium (not headless-shell). CHROMIUM_PATH lets you point at a local build.
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  else opts.channel = 'chromium';
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'doppel-')), opts);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  return { ctx, sw, extId, setRules: (rules, enabled = true) => sw.evaluate(
    ([r, e]) => chrome.storage.local.set({ apiov_rules: r, apiov_enabled: e, apiov_rev: Date.now() + Math.random() }), [rules, enabled]) };
}

export function server() {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/slow')) {
      return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"real":"slow"}'); }, 300);
    }
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-real': '1' });
      return res.end(JSON.stringify({ real: true, path: req.url, method: req.method }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>t</title><script>window.early = fetch("/api/early").then(r => r.status)</script>');
  });
  return new Promise((resolve) => srv.listen(0, () => resolve({ srv, base: `http://localhost:${srv.address().port}` })));
}

export const rule = (p) => ({
  id: Math.random().toString(36).slice(2), name: '', enabled: true, method: 'ANY', matchType: 'contains',
  ignoreQuery: false, status: null, body: '', delay: 0, mockOnly: false, updatedAt: 1, ...p
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
