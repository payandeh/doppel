import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const { matches, findRule, sequence } = loadScript('lib/match.js', 'APIOV_MATCH');
const rule = (p) => ({ enabled: true, method: 'ANY', matchType: 'equals', ignoreQuery: false, ...p });

test('equals, with and without query string', () => {
  const r = rule({ pattern: 'https://api.io/users?page=1' });
  assert.equal(matches(r, 'https://api.io/users?page=1', 'GET'), true);
  assert.equal(matches(r, 'https://api.io/users?page=2', 'GET'), false);
  const q = rule({ pattern: 'https://api.io/users', ignoreQuery: true });
  assert.equal(matches(q, 'https://api.io/users?page=2', 'GET'), true);
  assert.equal(matches(q, 'https://api.io/users/1', 'GET'), false);
});

test('contains, wildcard and regex', () => {
  assert.equal(matches(rule({ matchType: 'contains', pattern: '/wallet' }), 'https://x.io/api/wallet/1', 'GET'), true);
  const w = rule({ matchType: 'wildcard', pattern: '*/api/items*' });
  assert.equal(matches(w, 'https://x.io/api/items?x=1', 'GET'), true);
  assert.equal(matches(w, 'https://x.io/api/other', 'GET'), false);
  assert.equal(
    matches(rule({ matchType: 'wildcard', pattern: 'https://x.io/a.b' }), 'https://x.io/aXb', 'GET'),
    false,
    'dots are literal'
  );
  const re = rule({ matchType: 'regex', pattern: '^https://shop\\.io/orders/\\d+$' });
  assert.equal(matches(re, 'https://shop.io/orders/42', 'GET'), true);
  assert.equal(matches(re, 'https://shop.io/orders/abc', 'GET'), false);
  assert.equal(
    matches(rule({ matchType: 'regex', pattern: '(' }), 'https://x.io', 'GET'),
    false,
    'invalid regex never matches'
  );
});

test('method filter', () => {
  const r = rule({ method: 'POST', matchType: 'contains', pattern: '/login' });
  assert.equal(matches(r, 'https://x.io/login', 'post'), true);
  assert.equal(matches(r, 'https://x.io/login', 'GET'), false);
});

test('first enabled match wins; disabled rules skipped unless asked', () => {
  const rules = [
    rule({ id: 'off', enabled: false, matchType: 'contains', pattern: '/a' }),
    rule({ id: 'first', matchType: 'contains', pattern: '/a' }),
    rule({ id: 'second', matchType: 'contains', pattern: '/a' })
  ];
  assert.equal(findRule(rules, 'https://x.io/a', 'GET').id, 'first');
  assert.equal(findRule(rules, 'https://x.io/a', 'GET', true).id, 'off');
  assert.equal(findRule(rules, 'https://x.io/b', 'GET'), null);
});

test('an "after" override waits for its trigger, then wins (A, B1 / B2 after A)', () => {
  const rules = [
    rule({ id: 'a', pattern: 'https://x.io/a' }),
    rule({ id: 'b1', pattern: 'https://x.io/b' }),
    rule({ id: 'b2', pattern: 'https://x.io/b', after: 'a' })
  ];
  const seq = sequence();
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b1');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b1');
  assert.equal(seq.pick(rules, 'https://x.io/a', 'GET').id, 'a');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b2');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b2');
  seq.reset();
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b1');
});

test('"after" beats list order, and the most recent trigger wins among several', () => {
  const rules = [
    rule({ id: 'b3', pattern: 'https://x.io/b', after: 'c' }),
    rule({ id: 'b2', pattern: 'https://x.io/b', after: 'a' }),
    rule({ id: 'a', pattern: 'https://x.io/a' }),
    rule({ id: 'c', pattern: 'https://x.io/c' })
  ];
  const seq = sequence();
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET'), null, 'no plain override for B, nothing ran yet');
  seq.pick(rules, 'https://x.io/c', 'GET');
  seq.pick(rules, 'https://x.io/a', 'GET');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b2');
  seq.pick(rules, 'https://x.io/c', 'GET');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b3');
});

test('"after" ignores disabled overrides and a trigger that never ran', () => {
  const rules = [
    rule({ id: 'b1', pattern: 'https://x.io/b' }),
    rule({ id: 'b2', pattern: 'https://x.io/b', after: 'gone' }),
    rule({ id: 'b3', pattern: 'https://x.io/b', after: 'a', enabled: false }),
    rule({ id: 'a', pattern: 'https://x.io/a' })
  ];
  const seq = sequence();
  seq.pick(rules, 'https://x.io/a', 'GET');
  assert.equal(seq.pick(rules, 'https://x.io/b', 'GET').id, 'b1');
  assert.equal(findRule(rules, 'https://x.io/b', 'GET').id, 'b1', 'findRule prefers plain overrides');
  assert.equal(findRule(rules.slice(1), 'https://x.io/b', 'GET').id, 'b2', '…and falls back to an "after" one');
});
