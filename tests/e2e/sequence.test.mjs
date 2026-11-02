import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launch, server, rule, sleep } from './helpers.mjs';

const RULES = [
  rule({ id: 'b3', name: 'B after C', pattern: '/api/b', body: '{"b":3}', after: 'c' }),
  rule({ id: 'a', name: 'A', pattern: '/api/a', body: '{"a":1}' }),
  rule({ id: 'b1', name: 'B first', pattern: '/api/b', body: '{"b":1}' }),
  rule({ id: 'b2', name: 'B after A', pattern: '/api/b', body: '{"b":2}', after: 'a' }),
  rule({ id: 'c', name: 'C passes through', pattern: '/api/c' })
];

let api;
before(async () => (api = await server()));
after(() => api.srv.close());

const call = (page, path) => page.evaluate((p) => fetch(p).then((r) => r.text()), path);
const callXhr = (page, path) =>
  page.evaluate(
    (p) =>
      new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open('GET', p);
        x.onload = () => res(x.responseText);
        x.send();
      }),
    path
  );

async function walk(page) {
  const out = [];
  out.push(await call(page, '/api/b'));
  out.push(await callXhr(page, '/api/b'));
  await call(page, '/api/a');
  out.push(await call(page, '/api/b'));
  out.push(await callXhr(page, '/api/b'));
  assert.match(await call(page, '/api/c'), /"real":true/);
  out.push(await call(page, '/api/b'));
  await call(page, '/api/a');
  out.push(await call(page, '/api/b'));
  return out;
}
const EXPECTED = ['{"b":1}', '{"b":1}', '{"b":2}', '{"b":2}', '{"b":3}', '{"b":2}'];

describe('page-level', () => {
  let ext, page;
  before(async () => {
    ext = await launch();
    await ext.setRules(RULES);
    page = await ext.ctx.newPage();
    await page.goto(api.base + '/');
  });
  after(() => ext.ctx.close());

  test('B answers B1 until A has run, then B2; C (pass-through) switches to B3', async () => {
    assert.deepEqual(await walk(page), EXPECTED);
  });

  test('reloading the page starts over', async () => {
    await page.reload();
    assert.equal(await call(page, '/api/b'), '{"b":1}');
  });
});

describe("network-level mode (Chrome's Network tab)", () => {
  let ext, page;
  before(async () => {
    ext = await launch();
    await ext.setRules(RULES);
    await ext.sw.evaluate(() => chrome.storage.local.set({ apiov_settings: { nativeNetwork: true } }));
    page = await ext.ctx.newPage();
    await page.goto(api.base + '/');
    const devtools = await ext.ctx.newPage();
    await devtools.goto(`chrome-extension://${ext.extId}/manager.html`);
    await page.bringToFront();
    const tabId = await ext.sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
    await devtools.evaluate((id) => (window.port = chrome.runtime.connect({ name: 'apiov-devtools:' + id })), tabId);
    await call(page, '/api/a');
    await sleep(500);
    await page.reload();
    await sleep(300);
    // eslint-disable-next-line no-undef
    assert.equal(await ext.sw.evaluate((id) => Native.isAttached(id), tabId), true);
  });
  after(() => ext.ctx.close());

  test('the same sequence, applied through the debugger; a reload starts over', async () => {
    assert.deepEqual(await walk(page), EXPECTED);
    await page.reload();
    await sleep(300);
    assert.equal(await call(page, '/api/b'), '{"b":1}');
  });
});

describe('editor and list', () => {
  let ext, page;
  before(async () => {
    ext = await launch();
    await ext.setRules(RULES.filter((r) => !r.after));
    page = await ext.ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto(`chrome-extension://${ext.extId}/manager.html`);
    await sleep(300);
  });
  after(() => ext.ctx.close());

  test('"Use only after" saves the trigger and the card shows it', async () => {
    await page.click('.rule[data-id="b1"] [data-act=edit]');
    const options = await page.$$eval('.modal [name=after] option', (o) => o.map((x) => x.textContent));
    assert.ok(!options.includes('B first'), 'an override cannot wait for itself');
    await page.selectOption('.modal [name=after]', { label: 'A' });
    assert.match(await page.textContent('[data-after-hint]'), /Skipped until “A”/);
    await page.click('[data-act=save]');
    await sleep(300);
    const { apiov_rules } = await ext.getState();
    assert.equal(apiov_rules.find((r) => r.id === 'b1').after, 'a');
    assert.equal((await page.textContent('.rule[data-id="b1"] .tag-after')).trim(), 'after: A');
  });

  test('a deleted trigger is flagged on the card', async () => {
    const { apiov_rules } = await ext.getState();
    await ext.setRules(apiov_rules.filter((r) => r.id !== 'a'));
    await sleep(300);
    assert.equal((await page.textContent('.rule[data-id="b1"] .tag-warn')).trim(), 'after: deleted override');
  });
});
