import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const { matches, findRule } = loadScript('lib/match.js', 'APIOV_MATCH');
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
