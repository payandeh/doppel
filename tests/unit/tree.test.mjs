import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const T = loadScript(['lib/match.js', 'lib/tree.js'], 'APIOV_TREE');
const { inOrder, activeRules } = loadScript('lib/match.js', 'APIOV_MATCH');

const grp = (id, parentId = null, p = {}) => ({ id, name: id, parentId, enabled: true, ...p });
const rule = (id, groupId = null, p = {}) => ({ id, groupId, enabled: true, pattern: '/' + id, ...p });
const ids = (list) => list.map((x) => x.id).join(',');

const groups = [grp('pay'), grp('wallet', 'pay'), grp('auth')];
const rules = [rule('login', 'auth'), rule('loose'), rule('balance', 'wallet'), rule('charge', 'pay')];

test('rules are ordered like the tree: sub-groups first, then the group’s own rules', () => {
  assert.equal(ids(inOrder(rules, groups)), 'balance,charge,login,loose');
});

test('a turned-off group pauses everything inside it', () => {
  const off = groups.map((x) => (x.id === 'pay' ? { ...x, enabled: false } : x));
  assert.equal(ids(activeRules(rules, off)), 'login,loose');
  assert.equal(T.isOn(off, 'wallet'), false);
  assert.equal(T.isOn(off, 'auth'), true);
});

test('rules in unknown groups and cyclic groups still show up exactly once', () => {
  const cyc = [grp('a', 'b'), grp('b', 'a')];
  const rs = [rule('x', 'a'), rule('y', 'b'), rule('z', 'ghost')];
  const out = ids(inOrder(rs, cyc)).split(',').sort().join(',');
  assert.equal(out, 'x,y,z');
  assert.equal(T.groupOf(cyc, rs[2]), null);
});

test('counts include nested groups', () => {
  const r = [...rules, rule('off', 'wallet', { enabled: false })];
  assert.deepEqual({ ...T.counts(r, groups, 'pay') }, { total: 3, active: 2, groups: 1 });
});

const R = (id) => ({ type: 'r', id });
const G = (id) => ({ type: 'g', id });
const level = (st, pid) =>
  T.children(st.rules, st.groups, pid)
    .map((c) => c.item.id)
    .join(',');

test('moving a rule into a group, at a position', () => {
  const top = T.placeItem(rules, groups, R('loose'), { parentId: 'auth', index: 0 });
  assert.equal(top.rules.find((r) => r.id === 'loose').groupId, 'auth');
  assert.equal(level(top, 'auth'), 'loose,login');
  const end = T.placeItem(rules, groups, R('loose'), { parentId: 'auth', index: Infinity });
  assert.equal(level(end, 'auth'), 'login,loose');
});

test('overrides and groups share one order, so a loose override can sit above every group', () => {
  assert.equal(level({ rules, groups }, null), 'pay,auth,loose');
  const st = T.toTop(rules, groups, R('loose'));
  assert.equal(level(st, null), 'loose,pay,auth');
  assert.equal(ids(inOrder(st.rules, st.groups)), 'loose,balance,charge,login');
});

test('move to top works inside a group', () => {
  const rs = [...rules, rule('refund', 'pay')];
  assert.equal(level({ rules: rs, groups }, 'pay'), 'wallet,charge,refund');
  const st = T.toTop(rs, groups, R('refund'));
  assert.equal(level(st, 'pay'), 'refund,wallet,charge');
  assert.equal(ids(inOrder(st.rules, st.groups)), 'refund,balance,charge,login,loose');
});

test('a group cannot be moved into its own descendant', () => {
  assert.equal(T.placeItem(rules, groups, G('pay'), { parentId: 'wallet' }), null);
  const st = T.placeItem(rules, groups, G('auth'), { parentId: 'pay', index: 1 });
  assert.equal(level(st, 'pay'), 'wallet,auth,charge');
});

test('move up/down steps past groups and overrides alike', () => {
  const st = T.shiftItem(rules, groups, R('loose'), -1);
  assert.equal(level(st, null), 'pay,loose,auth');
  const back = T.shiftItem(st.rules, st.groups, G('pay'), 1);
  assert.equal(level(back, null), 'loose,pay,auth');
});

test('deleting a group can keep or drop its contents', () => {
  const keep = T.removeGroup(rules, groups, 'pay', true);
  assert.equal(ids(keep.groups), 'wallet,auth');
  assert.equal(level(keep, null), 'wallet,charge,auth,loose', 'contents take the group’s place');
  assert.equal(keep.groups[0].parentId, null);
  assert.equal(keep.rules.find((r) => r.id === 'charge').groupId, null);
  const drop = T.removeGroup(rules, groups, 'pay', false);
  assert.equal(ids(drop.groups), 'auth');
  assert.equal(ids(drop.rules), 'login,loose');
});

test('exporting a nested group makes it the top level of the file', () => {
  const data = T.exportGroup(rules, groups, 'wallet');
  assert.equal(data.version, 2);
  assert.deepEqual(
    data.groups.map((x) => [x.id, x.parentId]),
    [['wallet', null]]
  );
  assert.equal(ids(data.rules), 'balance');
});

test('exporting a selection keeps the structure of what was picked', () => {
  const data = T.exportData(rules, groups, { ruleIds: ['balance', 'loose'], groupIds: ['pay', 'wallet'] });
  assert.equal(ids(data.groups), 'pay,wallet');
  assert.equal(data.groups[1].parentId, 'pay');
  assert.equal(ids(data.rules), 'loose,balance');
  assert.equal(data.rules[0].groupId, null);
});

test('importing remaps ids that already exist and keeps the tree', () => {
  const incoming = T.parseImport(T.exportGroup(rules, groups, 'pay'));
  const out = T.importData(rules, groups, incoming);
  assert.equal(out.added, 2);
  assert.equal(level(out, null).split(',')[0], out.groups.find((x) => x.name === 'pay' && x.id !== 'pay').id);
  assert.equal(out.groups.length, 5);
  const [pay2, wallet2] = out.groups;
  assert.notEqual(pay2.id, 'pay');
  assert.equal(wallet2.parentId, pay2.id);
  const balance2 = out.rules.find((r) => r.pattern === '/balance' && r.id !== 'balance');
  assert.equal(balance2.groupId, wallet2.id);
  assert.equal(new Set([...out.rules, ...out.groups].map((x) => x.id)).size, out.rules.length + out.groups.length);
});

test('importing an old flat file still works', () => {
  const incoming = T.parseImport({ version: 1, rules: [{ id: 'n', pattern: '/n' }, { nope: 1 }] });
  const out = T.importData([], [], incoming);
  assert.equal(out.added, 1);
  assert.equal(out.rules[0].groupId, null);
});
