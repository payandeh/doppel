import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, server, rule, group, sleep } from './helpers.mjs';

let ext, api, page;
const initial = {
  groups: [group('Payments'), group('Wallet', { parentId: 'Payments' }), group('Auth')],
  rules: [
    rule({ id: 'login', name: 'login', pattern: '/api/login', status: 401, groupId: 'Auth' }),
    rule({ id: 'balance', name: 'balance', pattern: '/api/balance', status: 503, groupId: 'Wallet' }),
    rule({ id: 'loose', name: 'loose', pattern: '/api/loose', status: 418 })
  ]
};
const state = async () => {
  const d = await ext.getState();
  return { rules: d.apiov_rules || [], groups: d.apiov_groups || [] };
};
const groupOf = async (id) => (await state()).rules.find((r) => r.id === id).groupId;

async function drag(from, to, y = 0.5) {
  const a = await page.locator(from).boundingBox();
  await page.mouse.move(a.x + 30, a.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 30, { steps: 4 });
  const b = await page.locator(to).boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height * y, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
}

before(async () => {
  api = await server();
  ext = await launch();
  await ext.setState(initial);
  page = await ext.ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(`chrome-extension://${ext.extId}/manager.html`);
  await sleep(300);
});
after(async () => {
  await ext.ctx.close();
  api.srv.close();
});

test('groups render as a nested tree with overrides inside', async () => {
  assert.equal(
    await page.isVisible('.group[data-gid="Payments"] .group[data-gid="Wallet"] .rule[data-id="balance"]'),
    true
  );
  assert.equal(await page.isVisible('.group[data-gid="Auth"] > .group-body > .rule[data-id="login"]'), true);
  assert.equal(await page.textContent('.group[data-gid="Payments"] > .group-head .g-count'), '1/1');
});

test('collapsing a group hides its content and is remembered', async () => {
  await page.click('.group[data-gid="Payments"] > .group-head [data-act=collapse]');
  assert.equal(await page.isVisible('.rule[data-id="balance"]'), false);
  await page.reload();
  await sleep(300);
  assert.equal(await page.isVisible('.rule[data-id="balance"]'), false);
  await page.click('.group[data-gid="Payments"] > .group-head [data-act=collapse]');
  assert.equal(await page.isVisible('.rule[data-id="balance"]'), true);
});

test('turning a group off pauses everything inside it, including sub-groups', async () => {
  const web = await ext.ctx.newPage();
  await web.goto(api.base + '/');
  const status = (p) => web.evaluate((p) => fetch(p).then((r) => r.status), p);
  assert.equal(await status('/api/balance'), 503);
  await page.click('.group[data-gid="Payments"] > .group-head .switch');
  await sleep(300);
  assert.equal(await status('/api/balance'), 200);
  assert.equal(await status('/api/login'), 401);
  assert.equal((await state()).rules.find((r) => r.id === 'balance').enabled, true, 'override keeps its own switch');
  assert.match(await page.textContent('.rule[data-id="balance"]'), /paused by group/);
  await page.click('.group[data-gid="Payments"] > .group-head .switch');
  await sleep(300);
  assert.equal(await status('/api/balance'), 503);
  await web.close();
});

test('drag an override onto a group to move it there', async () => {
  await drag('.rule[data-id="loose"]', '.group[data-gid="Auth"] > .group-head');
  assert.equal(await groupOf('loose'), 'Auth');
});

test('drag an override above another one, then out to the top level', async () => {
  await drag('.rule[data-id="loose"]', '.rule[data-id="login"]', 0.1);
  const auth = await page.$$eval('.group[data-gid="Auth"] > .group-body > .rule', (els) =>
    els.map((x) => x.dataset.id)
  );
  assert.deepEqual(auth, ['loose', 'login']);
  await drag('.rule[data-id="loose"]', '[data-drop-root]');
  assert.equal(await groupOf('loose'), null);
});

test('dragging shows a labelled drop slot, and a loose override can go above every group', async () => {
  const first = '.rules > li:first-child';
  await page.evaluate((first) => {
    const fire = (el, type, y) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: r.x + 40,
          clientY: y ?? r.y + 3,
          dataTransfer: new DataTransfer()
        })
      );
    };
    fire(document.querySelector('.rule[data-id="loose"]'), 'dragstart');
    fire(document.querySelector(`${first} > .group-head`), 'dragover');
  }, first);
  assert.equal((await page.textContent('.drop-slot')).trim(), '➜ Top of the list');
  assert.equal(await page.evaluate((f) => document.querySelector(f).className, first), 'drop-slot');
  await page.evaluate(() => {
    const slot = document.querySelector('.drop-slot');
    slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await sleep(300);
  assert.equal(await page.getAttribute(first, 'data-id'), 'loose');
  assert.equal(await page.isVisible('.drop-slot'), false);
});

test('"Move to top" moves an override to the top of its group', async () => {
  await ext.setState({
    ...initial,
    rules: [...initial.rules, rule({ id: 'refresh', name: 'refresh', pattern: '/api/refresh', groupId: 'Auth' })]
  });
  await sleep(300);
  const order = () =>
    page.$$eval('.group[data-gid="Auth"] > .group-body > .rule', (els) => els.map((x) => x.dataset.id));
  assert.deepEqual(await order(), ['login', 'refresh']);
  await page.click('.rule[data-id="refresh"] [data-act=top]');
  await sleep(300);
  assert.deepEqual(await order(), ['refresh', 'login']);
  assert.equal(await page.isDisabled('.rule[data-id="refresh"] [data-act=top]'), true);
  await ext.setState(initial);
  await sleep(300);
});

test('"Move to…" moves an override into a nested group', async () => {
  await page.click('.rule[data-id="loose"] [data-act=move-to]');
  await page.click('.dmenu button:has-text("Wallet")');
  await sleep(300);
  assert.equal(await groupOf('loose'), 'Wallet');
});

test('a dragged item folds away and its slot starts at its current position', async () => {
  await page.evaluate(() => {
    const head = document.querySelector('.group[data-gid="Payments"] > .group-head');
    head.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  });
  await sleep(100);
  assert.equal(await page.isVisible('.group[data-gid="Wallet"]'), false, 'sub-groups cannot be targeted');
  assert.equal((await page.textContent('.drop-slot')).trim(), '↺ Current position');
  await page.evaluate(() => {
    const slot = document.querySelector('.drop-slot');
    slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await sleep(300);
  assert.equal(await page.isVisible('.drop-slot'), false);
  assert.equal(await page.isVisible('.group[data-gid="Wallet"]'), true);
  const { groups } = await state();
  assert.equal(groups.find((x) => x.id === 'Payments').parentId, null);
});

test('create and rename a group', async () => {
  await page.click('[data-act=new-group]');
  await page.fill('.g-rename', 'Checkout');
  await page.keyboard.press('Enter');
  await sleep(300);
  const { groups } = await state();
  assert.ok(groups.some((x) => x.name === 'Checkout' && x.parentId === null));
  assert.equal(await page.isVisible('.group-head .g-name:has-text("Checkout")'), true);
});

test('the editor can pick the group', async () => {
  await page.click('.rule[data-id="login"] [data-act=edit]');
  await page.selectOption('.modal [name=groupId]', 'Payments');
  await page.click('[data-act=save]');
  await sleep(300);
  assert.equal(await groupOf('login'), 'Payments');
});

test('export dialog exports only the checked groups and overrides', async () => {
  await page.click('[data-act=export]');
  await page.uncheck('[data-all]');
  await page.check('.export-tree input[data-id="Payments"]');
  assert.equal(await page.isChecked('.export-tree input[data-id="balance"]'), true);
  await page.uncheck('.export-tree input[data-id="Wallet"]');
  assert.equal(
    await page.evaluate(() => document.querySelector('.export-tree input[data-id="Payments"]').indeterminate),
    true
  );
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-x=export]')]);
  const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.deepEqual(data.rules.map((r) => r.id).sort(), ['login']);
  assert.deepEqual(data.groups.map((x) => x.id).sort(), ['Payments']);
});

test('a single group can be exported from its menu', async () => {
  await page.click('.group[data-gid="Wallet"] > .group-head [data-act=gmenu]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.dmenu button:has-text("Export")')]);
  assert.equal(dl.suggestedFilename(), 'doppel-wallet.json');
  const data = JSON.parse(await readFile(await dl.path(), 'utf8'));
  assert.deepEqual(
    data.groups.map((x) => [x.id, x.parentId]),
    [['Wallet', null]]
  );
  assert.deepEqual(data.rules.map((r) => r.id).sort(), ['balance', 'loose']);
});

test('deleting a group can keep its overrides', async () => {
  await page.click('.group[data-gid="Payments"] > .group-head [data-act=gmenu]');
  await page.click('.dmenu button:has-text("Delete group")');
  await page.click('.confirm button:has-text("keep contents")');
  await sleep(300);
  const { groups, rules } = await state();
  assert.equal(
    groups.find((x) => x.id === 'Payments'),
    undefined
  );
  assert.equal(groups.find((x) => x.id === 'Wallet').parentId, null);
  assert.equal(rules.find((r) => r.id === 'login').groupId, null);
});

test('the drop slot never jumps back and forth while the pointer holds still', async () => {
  await ext.setState({
    groups: [],
    rules: ['a', 'b', 'c', 'd', 'e'].map((id, i) => rule({ id, name: id, pattern: '/' + id, sort: i }))
  });
  await sleep(300);
  const flips = await page.evaluate(async () => {
    const fire = (el, type, y) =>
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: y,
          dataTransfer: new DataTransfer()
        })
      );
    fire(document.querySelector('.rule[data-id="c"]'), 'dragstart', 0);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    const list = document.querySelector('.rules');
    const top = list.getBoundingClientRect().top;
    const bottom = document.querySelector('.rule[data-id="e"]').getBoundingClientRect().bottom;
    let flips = 0;
    for (let y = top + 12; y < bottom; y += 3) {
      for (let k = 0; k < 4; k++) {
        const before = [...list.children].indexOf(document.querySelector('.drop-slot'));
        const el = document.elementFromPoint(300, y);
        if (el) fire(el, 'dragover', y);
        const after = [...list.children].indexOf(document.querySelector('.drop-slot'));
        if (k > 0 && before !== after) flips++;
      }
    }
    list.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return flips;
  });
  assert.equal(flips, 0);
});
