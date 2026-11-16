import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadScript } from './load.mjs';

const T = loadScript('lib/content-type.js', 'APIOV_TYPE');

test('JSON stays the default, including short name and charset', () => {
  assert.equal(T.header(''), 'application/json; charset=utf-8');
  assert.equal(T.header(undefined), 'application/json; charset=utf-8');
  assert.equal(T.header('application/json'), 'application/json; charset=utf-8');
  assert.equal(T.header('Application/JSON; charset=utf-8'), 'application/json; charset=utf-8');
  assert.equal(T.header('json'), 'application/json; charset=utf-8');
  assert.equal(T.stored('application/json'), '');
  assert.equal(T.stored('json'), '');
  assert.equal(T.stored('application/json; charset=utf-8'), '');
  assert.equal(T.isJson(''), true);
  assert.equal(T.isJson(undefined), true);
  assert.equal(T.isJson('application/ld+json'), true);
  assert.equal(T.isJson('application/problem+json'), true);
  assert.equal(T.isJson('text/json'), true);
});

test('text, markup and other media types are accepted', () => {
  assert.equal(T.header('text/html'), 'text/html; charset=utf-8');
  assert.equal(T.header('HTML'), 'text/html; charset=utf-8');
  assert.equal(T.header('text/plain'), 'text/plain; charset=utf-8');
  assert.equal(T.header('text'), 'text/plain; charset=utf-8');
  assert.equal(T.header('application/xml'), 'application/xml; charset=utf-8');
  assert.equal(T.header('xml'), 'application/xml; charset=utf-8');
  assert.equal(T.header('image/svg+xml'), 'image/svg+xml; charset=utf-8');
  assert.equal(T.header('text/css'), 'text/css; charset=utf-8');
  assert.equal(T.header('application/javascript'), 'application/javascript; charset=utf-8');
  assert.equal(T.header('js'), 'application/javascript; charset=utf-8');
  assert.equal(T.header('text/csv'), 'text/csv; charset=utf-8');
  assert.equal(T.header('text/event-stream'), 'text/event-stream; charset=utf-8');
  assert.equal(T.header('application/graphql'), 'application/graphql; charset=utf-8');
  assert.equal(T.header('application/x-www-form-urlencoded'), 'application/x-www-form-urlencoded; charset=utf-8');
  assert.equal(T.header('application/octet-stream'), 'application/octet-stream');
  assert.equal(T.header('binary'), 'application/octet-stream');
  assert.equal(T.header('application/pdf'), 'application/pdf');
  assert.equal(T.header('image/png'), 'image/png');
  assert.equal(T.header('multipart/form-data'), 'multipart/form-data');
  assert.equal(T.stored('text/html'), 'text/html');
  assert.equal(T.stored('html'), 'text/html');
  assert.equal(T.stored('text/html; charset=utf-8'), 'text/html');
  assert.equal(T.stored('text/html; charset=ISO-8859-1'), 'text/html; charset=ISO-8859-1');
  assert.equal(T.header('text/html; charset=ISO-8859-1'), 'text/html; charset=ISO-8859-1');
  assert.equal(T.isJson('text/html'), false);
  assert.equal(T.isJson('application/xml'), false);
  assert.equal(T.parse('nope').ok, false);
  assert.equal(T.parse(''), null);
  assert.equal(T.parse('text/html').type, 'text/html');
  assert.equal(T.header('application/vnd.custom+json'), 'application/vnd.custom+json; charset=utf-8');
  for (const t of T.TYPES) assert.equal(T.parse(t).ok, true, t);
});

test('the page interceptor agrees with the shared header rules', () => {
  const src = readFileSync(new URL('../../content/inject.js', import.meta.url), 'utf8').replace(
    /\n\/\/# sourceMappingURL=.*/,
    ''
  );
  const m = src.match(/function contentTypeHeader\(value\) \{\n[\s\S]*?\n {2}\}/);
  assert.ok(m, 'contentTypeHeader not found in content/inject.js');
  const header = vm.runInNewContext(`${m[0]}\ncontentTypeHeader`);
  const samples = [
    undefined,
    '',
    'json',
    'html',
    'text/html',
    'TEXT/HTML',
    'application/json',
    'application/json; charset=utf-8',
    'text/html; charset=ISO-8859-1',
    'application/octet-stream',
    'application/problem+json',
    'image/svg+xml',
    'image/png',
    'application/xml',
    'text/plain',
    'application/javascript',
    'multipart/form-data',
    'application/pdf',
    'not a type',
    'application/vnd.custom+json'
  ];
  for (const s of samples) assert.equal(header(s), T.header(s), String(s));
});
