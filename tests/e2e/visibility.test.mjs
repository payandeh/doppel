// Overridden responses must be visible somewhere in DevTools:
// - by default, Doppel's own DevTools tab gets a report of what the page received;
// - with "Show overrides in Chrome's Network tab", the override is applied at the network layer,
//   so a DevTools client (here: a raw CDP session) reads the overridden body from the Network domain.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launch, server, rule, sleep } from './helpers.mjs';

const RULES = [
  rule({ pattern: '/api/body', status: 418, body: '{"mock":true}' }),
  rule({ pattern: '/api/status', status: 503 }),
  rule({ pattern: '/api/mock-only', body: '{"mocked":1}', mockOnly: true })
];

let api;
before(async () => (api = await server()));
after(() => api.srv.close());

// Network-domain view of a request, the same way the DevTools front-end reads it.
async function networkView(ctx, page, run) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const seen = new Map();
  cdp.on('Network.responseReceived', (e) =>
    seen.set(e.requestId, { url: e.response.url, status: e.response.status, headers: e.response.headers })
  );
  const done = new Set();
  cdp.on('Network.loadingFinished', (e) => done.add(e.requestId));
  await run();
  await sleep(300);
  const out = {};
  for (const [id, r] of seen) {
    if (!done.has(id)) continue;
    let body = null;
    try {
      body = (await cdp.send('Network.getResponseBody', { requestId: id })).body;
    } catch (_) {}
    const marker = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'x-doppel');
    out[new URL(r.url).pathname] = { status: r.status, body, ...(marker && { doppel: marker[1] }) };
  }
  await cdp.detach();
  return out;
}

const fetchAll = (page) =>
  page.evaluate(async () => {
    const r = {};
    for (const p of ['/api/body', '/api/status', '/api/mock-only']) {
      const x = await fetch(p);
      r[p] = { status: x.status, body: await x.text() };
    }
    return r;
  });

describe('default (page-level) mode', () => {
  let ext, page, listener;
  before(async () => {
    ext = await launch();
    await ext.setRules(RULES);
    listener = await ext.ctx.newPage();
    await listener.goto(`chrome-extension://${ext.extId}/manager.html`);
    await listener.evaluate(() => {
      window.recs = [];
      chrome.runtime.onMessage.addListener((m) => m.type === 'apiov:applied' && window.recs.push(m.rec));
    });
    page = await ext.ctx.newPage();
    await page.goto(api.base + '/');
  });
  after(() => ext.ctx.close());

  test('the page gets the overrides; Chrome sees the real response (not an empty one)', async () => {
    let got;
    const net = await networkView(ext.ctx, page, async () => (got = await fetchAll(page)));
    assert.deepEqual(got['/api/body'], { status: 418, body: '{"mock":true}' });
    assert.equal(got['/api/status'].status, 503);
    assert.deepEqual(got['/api/mock-only'], { status: 200, body: '{"mocked":1}' });
    // Real body is drained, not cancelled, so DevTools can show it.
    assert.match(net['/api/body'].body, /"real":true/);
    assert.equal(net['/api/mock-only'], undefined);
  });

  test("reports what the page received to Doppel's DevTools tab", async () => {
    const recs = await listener.evaluate(() => window.recs);
    const by = Object.fromEntries(recs.map((r) => [new URL(r.url).pathname, r]));
    assert.equal(by['/api/body'].status, 418);
    assert.equal(by['/api/body'].realStatus, 200);
    assert.equal(by['/api/body'].body, '{"mock":true}');
    assert.equal(by['/api/body'].via, 'page');
    assert.equal(by['/api/status'].status, 503);
    assert.match(by['/api/status'].body, /"real":true/);
    assert.equal(by['/api/mock-only'].mocked, true);
  });
});

describe("network-level mode (Chrome's Network tab)", () => {
  let ext, page, devtools, logs, tabId;
  // Native is the background service worker's network-level module (lib/native.js).
  // eslint-disable-next-line no-undef
  const attached = (id = tabId) => ext.sw.evaluate((id) => Native.isAttached(id), id);
  const openDevtools = (id) =>
    devtools.evaluate((id) => {
      window.recs = [];
      window.port = chrome.runtime.connect({ name: 'apiov-devtools:' + id });
      window.port.onMessage.addListener((m) => m.type === 'applied' && window.recs.push(m.rec));
    }, id);
  const activeTabId = async (p) => {
    await p.bringToFront();
    return ext.sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
  };

  before(async () => {
    ext = await launch();
    await ext.setRules(RULES);
    await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_settings: { nativeNetwork: true } }));
    page = await ext.ctx.newPage();
    logs = [];
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(api.base + '/');
    devtools = await ext.ctx.newPage();
    await devtools.goto(`chrome-extension://${ext.extId}/manager.html`);
    tabId = await activeTabId(page);
    // Stand-in for devtools.js: an open port means "DevTools is open on this tab".
    await openDevtools(tabId);
    await sleep(500);
  });
  after(() => ext.ctx.close());

  test('no debugging bar for a site where Doppel has not overridden anything yet', async () => {
    assert.equal(await attached(), false);
  });

  test('the first override on a site attaches; after a reload every request goes through the network', async () => {
    assert.equal(await page.evaluate(() => fetch('/api/body').then((r) => r.status)), 418);
    await sleep(500);
    assert.equal(await attached(), true);
    await page.reload();
    await sleep(300);
    assert.equal(await attached(), true);
  });

  test('Chrome sees the overridden status and body; the page gets the same', async () => {
    let got;
    logs.length = 0;
    const net = await networkView(ext.ctx, page, async () => (got = await fetchAll(page)));
    assert.deepEqual(got['/api/body'], { status: 418, body: '{"mock":true}' });
    assert.equal(net['/api/body'].status, 418);
    assert.equal(net['/api/body'].body, '{"mock":true}');
    assert.equal(got['/api/status'].status, 503);
    assert.equal(net['/api/status'].status, 503);
    assert.match(net['/api/status'].body, /"real":true/);
    assert.deepEqual(net['/api/mock-only'], { status: 200, body: '{"mocked":1}', doppel: 'mocked: status 200, body' });
    // Rows are marked so they stand out in the Network tab.
    assert.equal(net['/api/body'].doppel, 'overridden: status 200 -> 418, body');
    assert.equal(net['/api/status'].doppel, 'overridden: status 200 -> 503');
    // The page-level patch stepped aside.
    assert.equal(logs.filter((l) => l.includes('[Doppel]')).length, 0);
  });

  test('XHR stays an XHR and is overridden too', async () => {
    const r = await page.evaluate(
      () =>
        new Promise((res) => {
          const x = new XMLHttpRequest();
          x.open('GET', '/api/body?x=1');
          x.onload = () => res({ status: x.status, body: x.responseText });
          x.send();
        })
    );
    assert.deepEqual(r, { status: 418, body: '{"mock":true}' });
  });

  test("reports to Doppel's DevTools tab over the port", async () => {
    const recs = await devtools.evaluate(() => window.recs);
    const body = recs.find((r) => r.url.endsWith('/api/body'));
    assert.equal(body.via, 'network');
    assert.equal(body.realStatus, 200);
  });

  test('turning Doppel off removes the debugging bar; turning it on brings it back', async () => {
    await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_enabled: false }));
    await sleep(500);
    assert.equal(await attached(), false);
    await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_enabled: true }));
    await sleep(500);
    assert.equal(await attached(), true);
  });

  test('a site without overrides in another tab is not attached, even with DevTools open', async () => {
    const other = await ext.ctx.newPage();
    await other.goto(api.base.replace('localhost', '127.0.0.1') + '/');
    const otherId = await activeTabId(other);
    await devtools.evaluate((id) => {
      window.port2 = chrome.runtime.connect({ name: 'apiov-devtools:' + id });
    }, otherId);
    await other.reload();
    await sleep(500);
    assert.equal(await attached(otherId), false);
    await devtools.evaluate(() => window.port2.disconnect());
    await other.close();
  });

  test('closing DevTools hands overrides back to the page', async () => {
    await devtools.evaluate(() => window.port.disconnect());
    await sleep(500);
    logs.length = 0;
    const net = await networkView(ext.ctx, page, async () => {
      const got = await fetchAll(page);
      assert.deepEqual(got['/api/body'], { status: 418, body: '{"mock":true}' });
    });
    assert.equal(net['/api/body'].status, 200);
    assert.ok(logs.some((l) => l.includes('[Doppel]')));
  });
});

test('the Settings checkbox turns the Network-tab mode on and off without a prompt', async () => {
  const ext = await launch();
  try {
    const page = await ext.ctx.newPage();
    await page.goto(`chrome-extension://${ext.extId}/manager.html`);
    await sleep(300);
    const setting = () =>
      ext.sw.evaluate(async () => !!(await chrome.storage.local.get('apiov_settings')).apiov_settings?.nativeNetwork);
    await page.check('#set-native');
    await sleep(200);
    assert.equal(await setting(), true);
    await page.reload();
    await sleep(300);
    assert.equal(await page.isChecked('#set-native'), true);
    await page.uncheck('#set-native');
    await sleep(200);
    assert.equal(await setting(), false);
  } finally {
    await ext.ctx.close();
  }
});
