import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, rule, sleep } from './helpers.mjs';

let ext, page;
before(async () => {
  ext = await launch();
  await ext.setRules([
    rule({
      id: 'r1',
      name: 'myBank',
      method: 'GET',
      matchType: 'equals',
      pattern: 'https://api.example.com/v1/wallet?page=1',
      status: 500
    })
  ]);
  page = await ext.ctx.newPage();
  await page.goto(`chrome-extension://${ext.extId}/manager.html`);
  await sleep(300);
});
after(() => ext.ctx.close());

const rules = async () => (await ext.sw.evaluate(() => chrome.storage.local.get('apiov_rules'))).apiov_rules;

test('override card splits host and route', async () => {
  assert.equal(await page.textContent('.rule[data-id="r1"] .rc-host'), 'https://api.example.com');
  assert.equal(await page.textContent('.rule[data-id="r1"] .rc-route'), '/v1/wallet?page=1');
});

test('editor blocks invalid JSON and points to the error', async () => {
  await page.click('.rule[data-id="r1"] [data-act=edit]');
  await page.click('.cm-content');
  await page.keyboard.type('{"a": 1,}');
  await sleep(300);
  assert.match(await page.textContent('.json-state'), /Line 1, col 9: Trailing comma/);
  await page.click('[data-act=save]');
  assert.match(await page.textContent('.modal .error'), /not valid JSON/);
  assert.equal((await rules())[0].body, '');
});

test('editor beautifies and saves valid JSON', async () => {
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('{"ok":true,"list":[1,2]}');
  await page.click('[data-act=format]');
  await page.click('[data-act=save]');
  await sleep(300);
  assert.equal((await rules())[0].body, '{\n  "ok": true,\n  "list": [\n    1,\n    2\n  ]\n}');
  assert.equal(await page.isVisible('.modal-back'), false);
});

test('toggle and duplicate from the card', async () => {
  await page.click('.rule[data-id="r1"] .switch');
  await sleep(200);
  assert.equal((await rules())[0].enabled, false);
  await page.click('.rule[data-id="r1"] [data-act=dup]');
  await sleep(200);
  assert.equal((await rules()).length, 2);
});
