import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const cors = loadScript('lib/cors.js', 'APIOV_CORS');
// Plain copies: values from the script's own realm are not deepEqual to this realm's arrays.
const headersFor = (...a) => JSON.parse(JSON.stringify(cors.headersFor(...a)));
const { originOf } = cors;
const asObj = (list) => Object.fromEntries(list.map((h) => [h.name, h.value]));

test('same-origin requests get no CORS headers', () => {
  assert.deepEqual(headersFor({ url: 'http://localhost:3000/api/x', headers: {} }, 'http://localhost:3000'), []);
});

test('cross-origin: exact page origin with credentials allowed, never "*"', () => {
  const h = asObj(headersFor({ url: 'https://api.example.com/users', headers: {} }, 'http://localhost:3000'));
  assert.equal(h['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(h['access-control-allow-credentials'], 'true');
  assert.equal(h['access-control-expose-headers'], 'x-doppel');
  assert.equal(h.vary, 'Origin');
});

test('the Origin request header wins over the page origin, whatever its case', () => {
  const h = asObj(
    headersFor({ url: 'https://api.example.com/', headers: { ORIGIN: 'https://app.example.com' } }, 'http://other')
  );
  assert.equal(h['access-control-allow-origin'], 'https://app.example.com');
});

test('a different port or scheme is cross-origin', () => {
  assert.equal(headersFor({ url: 'http://localhost:4000/a', headers: {} }, 'http://localhost:3000').length, 4);
  assert.equal(headersFor({ url: 'https://localhost:3000/a', headers: {} }, 'http://localhost:3000').length, 4);
});

test('opaque "null" origins (sandboxed frames, file://) are echoed as is', () => {
  const h = asObj(headersFor({ url: 'https://api.example.com/', headers: { Origin: 'null' } }, undefined));
  assert.equal(h['access-control-allow-origin'], 'null');
});

test('unknown origin or bad URL: no headers instead of a throw', () => {
  assert.deepEqual(headersFor({ url: 'https://api.example.com/', headers: {} }, undefined), []);
  assert.deepEqual(headersFor({ url: 'not a url', headers: {} }, 'http://localhost:3000'), []);
  assert.equal(originOf('nope'), null);
  assert.equal(originOf('https://a.io:8443/x?y'), 'https://a.io:8443');
});
