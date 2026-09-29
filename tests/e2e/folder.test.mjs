// Folder sync. Chrome's folder picker needs a real click, so tests swap in the
// origin-private file system, which gives the same kind of directory handle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, rule, sleep } from './helpers.mjs';

let ext, page;
const names = async () => ((await ext.sw.evaluate(() => chrome.storage.local.get('apiov_rules'))).apiov_rules || []).map((r) => r.name).join(',');
const readFile = () => page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('mocks', { create: true });
  try { return JSON.parse(await (await (await d.getFileHandle('doppel.json')).getFile()).text()).rules.map((r) => r.name).join(','); }
  catch { return null; }
});
const writeFile = (text) => page.evaluate(async (text) => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('mocks', { create: true });
  const w = await (await d.getFileHandle('doppel.json', { create: true })).createWritable();
  await w.write(text); await w.close();
}, text);
const openManager = async () => {
  page = await ext.ctx.newPage();
  await page.goto(`chrome-extension://${ext.extId}/manager.html`);
  await page.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('mocks', { create: true }); });
  await sleep(300);
};

before(async () => {
  ext = await launch();
  await ext.setRules([rule({ id: 'a', name: 'A', pattern: '/a' }), rule({ id: 'b', name: 'B', pattern: '/b' })]);
  await openManager();
});
after(() => ext.ctx.close());

test('connecting an empty folder saves the overrides there', async () => {
  await page.click('#folder-choose');
  await sleep(700);
  assert.equal(await readFile(), 'A,B');
  assert.match(await page.textContent('#folder-sub'), /Saved to doppel\.json/);
});

test('changes are saved automatically, even with no page open', async () => {
  await page.close();
  await ext.sw.evaluate(async () => {
    const d = await chrome.storage.local.get('apiov_rules');
    d.apiov_rules.push({ id: 'c', name: 'C', enabled: true, method: 'ANY', matchType: 'contains', pattern: '/c', status: 404, body: '', updatedAt: Date.now() });
    await chrome.storage.local.set({ apiov_rules: d.apiov_rules, apiov_rev: Date.now() + Math.random() });
  });
  await sleep(1000);
  await openManager();
  assert.equal(await readFile(), 'A,B,C');
});

test('after a "reinstall", choosing the same folder restores everything', async () => {
  await ext.sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await new Promise((r) => { const q = indexedDB.deleteDatabase('apiov-folder'); q.onsuccess = q.onerror = q.onblocked = r; });
  });
  await page.reload();
  await page.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('mocks'); });
  await sleep(300);
  assert.equal(await names(), '');
  await page.click('#folder-choose');
  await sleep(800);
  assert.equal(await names(), 'A,B,C');
});

test('a broken file is reported and never overwritten', async () => {
  await writeFile('{ "rules": [ oops ');
  await page.click('#folder-sync');
  await sleep(500);
  assert.match(await page.textContent('#folder-sub'), /not valid JSON/);
  const raw = await page.evaluate(async () => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('mocks');
    return (await (await d.getFileHandle('doppel.json')).getFile()).text();
  });
  assert.equal(raw, '{ "rules": [ oops ');
});
