import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = new URL('../../mcp/server.mjs', import.meta.url).pathname;

// Runs one MCP session over stdio and returns each response by request id.
async function session(dir, calls) {
  const p = spawn(process.execPath, [SERVER, dir], { stdio: ['pipe', 'pipe', 'inherit'] });
  const msgs = [
    { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { method: 'notifications/initialized' },
    ...calls.map(([name, args], i) => ({ id: i + 1, method: 'tools/call', params: { name, arguments: args } }))
  ];
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.end(msgs.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n');
  await new Promise((r) => p.on('close', r));
  const byId = new Map(
    out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((m) => [m.id, m])
  );
  return calls.map((_, i) => byId.get(i + 1).result);
}

function folder(rules = [], groups = []) {
  const dir = mkdtempSync(join(tmpdir(), 'doppel-mcp-'));
  writeFileSync(join(dir, 'doppel.json'), JSON.stringify({ app: 'doppel', version: 2, enabled: true, groups, rules }));
  return dir;
}
const read = (dir) => JSON.parse(readFileSync(join(dir, 'doppel.json'), 'utf8'));

test('add_override writes a rule the extension can read, at the top of its group', async () => {
  const dir = folder([{ id: 'old', name: 'Old', enabled: true, matchType: 'contains', pattern: '/api/a', sort: 0 }]);
  const [res] = await session(dir, [
    ['add_override', { name: 'Fail', pattern: '/api/a', method: 'post', status: 500, body: { error: 'x' } }]
  ]);
  assert.equal(res.isError, undefined);
  const { rules } = read(dir);
  const added = rules.find((r) => r.name === 'Fail');
  assert.equal(added.method, 'POST');
  assert.equal(added.matchType, 'contains');
  assert.equal(added.status, 500);
  assert.deepEqual(JSON.parse(added.body), { error: 'x' });
  assert.equal(added.sort, 0);
  assert.equal(rules.find((r) => r.id === 'old').sort, 1);
});

test('groups are created from a path and overrides can wait for another', async () => {
  const dir = folder([{ id: 'pay', name: 'Pay', enabled: true, matchType: 'contains', pattern: '/pay' }]);
  const [, list] = await session(dir, [
    ['add_override', { name: 'B2', pattern: '/b', body: [1], group: 'Checkout / Later', after: 'Pay' }],
    ['list_groups', {}]
  ]);
  const { rules, groups } = read(dir);
  const b2 = rules.find((r) => r.name === 'B2');
  assert.equal(b2.after, 'pay');
  assert.deepEqual(
    list.structuredContent.groups.map((g) => g.path),
    ['Checkout', 'Checkout / Later']
  );
  assert.equal(b2.groupId, groups.find((g) => g.name === 'Later').id);
});

test('bad input is reported to the agent and leaves the file alone', async () => {
  const dir = folder();
  const before = readFileSync(join(dir, 'doppel.json'), 'utf8');
  const res = await session(dir, [
    ['add_override', { pattern: '/x', status: 99 }],
    ['add_override', { pattern: '/x', body: '{not json' }],
    ['add_override', { pattern: '/x' }],
    ['add_override', { pattern: '/x', mock_only: true, status: 200 }],
    ['update_override', { id: 'nope', status: 200 }]
  ]);
  for (const r of res) assert.equal(r.isError, true, JSON.stringify(r));
  assert.equal(readFileSync(join(dir, 'doppel.json'), 'utf8'), before);
});

test('a folder that Doppel has not synced to yet gets a helpful error, not a new file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doppel-mcp-'));
  const [res] = await session(dir, [['add_override', { pattern: '/x', status: 500 }]]);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Sync to a folder/);
});

test('set_enabled switches overrides, groups and Doppel itself', async () => {
  const dir = folder(
    [{ id: 'r', name: 'R', enabled: true, matchType: 'contains', pattern: '/r', groupId: 'g' }],
    [{ id: 'g', name: 'Team', parentId: null, enabled: true }]
  );
  await session(dir, [
    ['set_enabled', { target: 'R', enabled: false }],
    ['set_enabled', { target: 'Team', enabled: false }],
    ['set_enabled', { enabled: false }]
  ]);
  const f = read(dir);
  assert.equal(f.rules[0].enabled, false);
  assert.equal(f.groups[0].enabled, false);
  assert.equal(f.enabled, false);
});
