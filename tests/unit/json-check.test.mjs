import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const JsonCheck = loadScript('lib/json-check.js', 'JsonCheck');

test('accepts valid JSON', () => {
  for (const s of ['{}', '[]', '"x"', '0', '-1.5e3', 'true', 'null', '{"a":[1,{"b":null}],"c":"\\u00e9\\n"}']) {
    assert.equal(JsonCheck.validate(s).ok, true, s);
  }
});

test('treats empty text as empty, not an error', () => {
  const r = JsonCheck.validate('   \n ');
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
});

test('reports helpful messages with line and column', () => {
  const cases = [
    ['{"a":1,}', 'Trailing comma', 1, 8],
    ["{'a':1}", 'double quotes', 1, 2],
    ['{a:1}', 'must be in double quotes', 1, 2],
    ['{"a":1 "b":2}', 'Missing ","', 1, 8],
    ['{"a":True}', 'use true', 1, 6],
    ['{"a":undefined}', 'undefined is not allowed', 1, 6],
    ['// hi\n{}', 'Comments are not allowed', 1, 1],
    ['{\n  "a": [1, 2,]\n}', 'Trailing comma', 2, 14],
    ['{"a":01}', 'Invalid number', 1, 6],
    ['{"a":"x', 'Unterminated string', 1, 6]
  ];
  for (const [src, msg, line, col] of cases) {
    const r = JsonCheck.validate(src);
    assert.equal(r.ok, false, src);
    assert.match(r.message, new RegExp(msg), src);
    assert.deepEqual([r.line, r.col], [line, col], src);
  }
});

test('agrees with JSON.parse on random input', () => {
  const atoms = ['{', '}', '[', ']', ',', ':', '"a"', '"b\\n"', '1', '-2.5e3', '0', '01', 'true', 'null', 'nul', ' ', '\n', '"', "'", '.', 'e'];
  let seed = 42;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 20000; k++) {
    let s = '';
    for (let j = 0, L = 1 + rand(12); j < L; j++) s += atoms[rand(atoms.length)];
    let native = true;
    try { JSON.parse(s); } catch { native = false; }
    const r = JsonCheck.validate(s);
    if (r.empty) continue;
    assert.equal(r.ok, native, JSON.stringify(s));
  }
});

test('format and minify', () => {
  assert.equal(JsonCheck.format('{"a":[1,2]}').text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(JsonCheck.minify('{ "a" : [ 1 , 2 ] }').text, '{"a":[1,2]}');
  assert.equal(JsonCheck.format('{"a":}').ok, false);
});
