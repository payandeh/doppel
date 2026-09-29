import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, server, rule, sleep } from './helpers.mjs';

let ext, api, page;
before(async () => {
  api = await server();
  ext = await launch();
  await ext.setRules([
    rule({ pattern: '/api/early', status: 500 }),
    rule({ pattern: '/api/status', method: 'GET', status: 503 }),
    rule({ pattern: '/api/body', body: '{"mock":true}' }),
    rule({ pattern: '/api/both', status: 404, body: '{"error":"nope"}' }),
    rule({ pattern: '/api/mock-only', method: 'POST', status: 201, body: '{"created":1}', mockOnly: true }),
    rule({ pattern: '/api/slow', body: '{"slow":1}', delay: 400 }),
    rule({ pattern: 'secret-other-site.example', body: '{"token":"SECRET"}' }),
    rule({ pattern: '/api/disabled', status: 500, enabled: false })
  ]);
  page = await ext.ctx.newPage();
  await page.goto(api.base + '/');
});
after(async () => {
  await ext.ctx.close();
  api.srv.close();
});

const xhr = (url, opts = {}) =>
  page.evaluate(
    ([url, opts]) =>
      new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open(opts.method || 'GET', url);
        if (opts.responseType) x.responseType = opts.responseType;
        if (opts.timeout) x.timeout = opts.timeout;
        const states = [];
        x.onreadystatechange = () => states.push(x.readyState);
        x.onload = () =>
          resolve({
            ev: 'load',
            status: x.status,
            body: opts.responseType ? x.response : x.responseText,
            type: x.getResponseHeader('content-type'),
            states: states.join('')
          });
        x.onerror = () => resolve({ ev: 'error' });
        x.ontimeout = () => resolve({ ev: 'timeout', status: x.status });
        x.onabort = () => resolve({ ev: 'abort', readyState: x.readyState });
        x.send(opts.body ?? null);
        if (opts.abortAfter) setTimeout(() => x.abort(), opts.abortAfter);
      }),
    [url, opts]
  );

test('overrides requests made while the page is loading', async () => {
  assert.equal(await page.evaluate(() => window.early), 500);
});

test('fetch: status only keeps the real body', async () => {
  const r = await page.evaluate(async () => {
    const x = await fetch('/api/status');
    return [x.status, x.statusText, await x.json()];
  });
  assert.deepEqual(r, [503, 'Service Unavailable', { real: true, path: '/api/status', method: 'GET' }]);
});

test('fetch: body only keeps the real status', async () => {
  const r = await page.evaluate(async () => {
    const x = await fetch('/api/body');
    return [x.status, await x.json(), x.headers.get('content-type')];
  });
  assert.deepEqual(r, [200, { mock: true }, 'application/json; charset=utf-8']);
});

test('fetch: status and body', async () => {
  const r = await page.evaluate(async () => {
    const x = await fetch('/api/both');
    return [x.status, await x.json()];
  });
  assert.deepEqual(r, [404, { error: 'nope' }]);
});

test('fetch: mock only works for a Request object and never hits the server', async () => {
  const r = await page.evaluate(async () => {
    const x = await fetch(new Request('/api/mock-only', { method: 'POST', body: 'x' }));
    return [x.status, await x.json()];
  });
  assert.deepEqual(r, [201, { created: 1 }]);
});

test('method filter and disabled overrides are respected', async () => {
  const r = await page.evaluate(async () => [
    (await fetch('/api/status', { method: 'POST' })).status,
    (await fetch('/api/disabled')).status
  ]);
  assert.deepEqual(r, [200, 200]);
});

test('XHR: status, text body and full readyState sequence', async () => {
  const r = await xhr('/api/both');
  assert.equal(r.ev, 'load');
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: 'nope' });
  assert.equal(r.states, '234');
});

test('XHR: responseType json', async () => {
  const r = await xhr('/api/body?x=1', { responseType: 'json' });
  assert.deepEqual(r.body, { mock: true });
});

test('XHR: timeout and abort on delayed overrides', async () => {
  assert.deepEqual(await xhr('/api/slow', { timeout: 100 }), { ev: 'timeout', status: 0 });
  assert.deepEqual(await xhr('/api/slow', { abortAfter: 50 }), { ev: 'abort', readyState: 4 });
});

test('requests without an override are untouched', async () => {
  const r = await page.evaluate(async () => {
    const x = await fetch('/api/other');
    return [x.status, (await x.json()).real];
  });
  assert.deepEqual(r, [200, true]);
  const x = await xhr('/api/other');
  assert.equal(x.status, 200);
});

test('a page cannot read overrides meant for other URLs', async () => {
  const seen = await page.evaluate(async () => {
    const out = [];
    for (const t of ['apiov:rules', 'apiov:state', 'apiov:match-result'])
      document.addEventListener(t, (e) => out.push(String(e.detail)));
    document.dispatchEvent(new CustomEvent('apiov:request-state'));
    document.dispatchEvent(new CustomEvent('apiov:request-rules'));
    await fetch('/api/body');
    return out.join(' ');
  });
  assert.equal(seen.includes('SECRET'), false);
});

test('global switch turns everything off', async () => {
  await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_enabled: false }));
  await sleep(200);
  assert.equal(await page.evaluate(async () => (await fetch('/api/both')).status), 200);
  await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_enabled: true }));
  await sleep(200);
  assert.equal(await page.evaluate(async () => (await fetch('/api/both')).status), 404);
});
