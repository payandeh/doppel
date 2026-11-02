#!/usr/bin/env node
// Doppel MCP server: lets an AI agent read and edit overrides through the doppel.json file that Doppel's
// "Sync to folder" keeps in step with the extension. Speaks MCP over stdio with no dependencies.
//
//   node mcp/server.mjs /path/to/synced-folder        (or the path to doppel.json itself, or DOPPEL_FOLDER=...)
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const FILE = 'doppel.json';
const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MATCH_TYPES = ['equals', 'contains', 'wildcard', 'regex'];

// Same ordering code the extension runs, so a new override lands exactly where the editor would put it.
const ctx = vm.createContext({});
ctx.globalThis = ctx;
for (const f of ['lib/match.js', 'lib/tree.js']) vm.runInContext(readFileSync(join(here, '..', f), 'utf8'), ctx);
const T = ctx.APIOV_TREE;

function filePath() {
  const arg = process.argv[2] || process.env.DOPPEL_FOLDER || process.env.DOPPEL_FILE;
  if (!arg) throw new UserError('No folder given. Start the server with the folder Doppel syncs to as its argument.');
  const p = resolve(arg.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  return existsSync(p) && statSync(p).isDirectory() ? join(p, FILE) : p;
}

class UserError extends Error {}

function load() {
  const path = filePath();
  if (!existsSync(path))
    throw new UserError(
      `There's no ${FILE} at ${path}. In Doppel open Manage overrides → "Sync to a folder" and choose ${dirname(path)} first.`
    );
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UserError(`${path} is not valid JSON (${e.message}).`);
  }
  if (Array.isArray(data)) data = { rules: data };
  if (!data || !Array.isArray(data.rules)) throw new UserError(`${path} doesn't look like a Doppel file.`);
  return {
    path,
    data,
    rules: data.rules.filter((r) => r && typeof r.pattern === 'string'),
    groups: (Array.isArray(data.groups) ? data.groups : []).filter((g) => g && g.id),
    enabled: data.enabled !== false
  };
}

// Write-then-rename, so Doppel never reads a half-written file.
function save(st) {
  const out = {
    ...st.data,
    app: 'doppel',
    version: 2,
    savedAt: Date.now(),
    enabled: st.enabled,
    groups: st.groups,
    rules: st.rules
  };
  const tmp = `${st.path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
  renameSync(tmp, st.path);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const groupPath = (groups, id) =>
  id
    ? [...T.ancestors(groups, id)]
        .filter(Boolean)
        .map((g) => g.name || '(unnamed)')
        .join(' / ')
    : '';

function findOne(list, ref, what) {
  if (typeof ref !== 'string' || !ref) throw new UserError(`Give the ${what}'s id or exact name.`);
  const byId = list.find((x) => x.id === ref);
  if (byId) return byId;
  const byName = list.filter((x) => (x.name || '') === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new UserError(`${byName.length} ${what}s are named "${ref}"; use the id instead.`);
  throw new UserError(`No ${what} with id or name "${ref}".`);
}

// "Team / Payments" → that nested group, created (enabled) if it doesn't exist yet.
function ensureGroup(st, path) {
  const parts = String(path)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  let parentId = null;
  for (const name of parts) {
    let g = T.childGroups(st.groups, parentId).find((x) => x.name === name);
    if (!g) {
      const now = Date.now();
      g = T.normalizeGroup({ id: uid(), name, parentId, enabled: true, createdAt: now, updatedAt: now });
      const placed = T.placeItem(st.rules, [...st.groups, g], { type: 'g', id: g.id }, { parentId, index: 0 });
      st.rules = placed.rules;
      st.groups = placed.groups;
    }
    parentId = g.id;
  }
  return parentId;
}

const normPath = (p) =>
  String(p)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ');
const findGroup = (st, ref) =>
  st.groups.find((g) => g.id === ref) || st.groups.find((g) => groupPath(st.groups, g.id) === normPath(ref));

function resolveGroup(st, ref) {
  if (ref === null || ref === '' || ref === '/') return null;
  const byId = st.groups.find((g) => g.id === ref);
  return byId ? byId.id : ensureGroup(st, ref);
}

function bodyText(body) {
  if (body === undefined) return undefined;
  if (body === null) return '';
  if (typeof body !== 'string') return JSON.stringify(body, null, 2);
  if (body.trim() === '') return '';
  try {
    JSON.parse(body);
  } catch (e) {
    throw new UserError(`body is a string but not valid JSON (${e.message}). Pass the JSON value itself instead.`);
  }
  return body;
}

function applyFields(st, rule, a) {
  if (a.name !== undefined) rule.name = String(a.name).trim();
  if (a.pattern !== undefined) {
    if (typeof a.pattern !== 'string' || !a.pattern.trim()) throw new UserError('pattern must be a non-empty string.');
    rule.pattern = a.pattern.trim();
  }
  if (a.match_type !== undefined) {
    if (!MATCH_TYPES.includes(a.match_type))
      throw new UserError(`match_type must be one of ${MATCH_TYPES.join(', ')}.`);
    rule.matchType = a.match_type;
  }
  if (rule.matchType === 'regex')
    try {
      new RegExp(rule.pattern);
    } catch (e) {
      throw new UserError(`pattern is not a valid regular expression (${e.message}).`);
    }
  if (a.method !== undefined) {
    const m = String(a.method).toUpperCase();
    if (!METHODS.includes(m)) throw new UserError(`method must be one of ${METHODS.join(', ')}.`);
    rule.method = m;
  }
  if (a.ignore_query !== undefined) rule.ignoreQuery = !!a.ignore_query;
  if (a.status !== undefined) {
    if (a.status !== null && !(Number.isInteger(a.status) && a.status >= 200 && a.status <= 599))
      throw new UserError('status must be a whole number from 200 to 599, or null to keep the real status.');
    rule.status = a.status;
  }
  const body = bodyText(a.body);
  if (body !== undefined) rule.body = body;
  if (a.delay_ms !== undefined) rule.delay = Math.max(0, parseInt(a.delay_ms, 10) || 0);
  if (a.mock_only !== undefined) rule.mockOnly = !!a.mock_only;
  if (rule.mockOnly && !(rule.body || '').trim())
    throw new UserError("mock_only needs a body, since the server won't be called.");
  if (a.enabled !== undefined) rule.enabled = !!a.enabled;
  if (a.after !== undefined) {
    if (a.after === null || a.after === '') delete rule.after;
    else {
      const other = findOne(st.rules, a.after, 'override');
      if (other.id === rule.id) throw new UserError("An override can't wait for itself.");
      rule.after = other.id;
    }
  }
}

function summary(st, r) {
  const gid = T.groupOf(st.groups, r);
  const after = r.after ? st.rules.find((x) => x.id === r.after) : null;
  return {
    id: r.id,
    name: r.name || '',
    enabled: r.enabled !== false,
    active: st.enabled && r.enabled !== false && T.isOn(st.groups, gid),
    method: r.method || 'ANY',
    match_type: r.matchType || 'equals',
    pattern: r.pattern,
    ...(r.ignoreQuery ? { ignore_query: true } : {}),
    status: Number.isInteger(r.status) ? r.status : null,
    has_body: typeof r.body === 'string' && r.body.trim() !== '',
    ...(r.delay ? { delay_ms: r.delay } : {}),
    ...(r.mockOnly ? { mock_only: true } : {}),
    ...(r.after ? { after: after ? { id: after.id, name: after.name || '' } : { id: r.after, missing: true } } : {}),
    group: gid ? { id: gid, path: groupPath(st.groups, gid) } : null
  };
}

function ordered(st) {
  const out = [];
  const walk = (pid) => {
    for (const c of T.children(st.rules, st.groups, pid)) c.type === 'g' ? walk(c.item.id) : out.push(c.item);
  };
  walk(null);
  return out;
}

const RULE_FIELDS = {
  name: { type: 'string', description: 'Label shown in Doppel. Optional but recommended.' },
  pattern: {
    type: 'string',
    description: 'What to match against the full request URL (e.g. "/api/orders" with match_type "contains").'
  },
  match_type: {
    type: 'string',
    enum: MATCH_TYPES,
    description:
      'How pattern matches the URL: equals (whole URL), contains (substring), wildcard (* = anything, whole URL), regex.'
  },
  method: { type: 'string', enum: METHODS, description: 'HTTP method to match. ANY matches all.' },
  ignore_query: { type: 'boolean', description: 'equals only: ignore the query string when comparing.' },
  status: {
    type: ['integer', 'null'],
    minimum: 200,
    maximum: 599,
    description: 'Response status to return. null keeps the real status.'
  },
  body: {
    description:
      'Response body: any JSON value (object, array, string, number…). Pass the value itself, not a JSON-encoded string. null or "" keeps the real body.'
  },
  delay_ms: { type: 'integer', minimum: 0, description: 'Extra delay before the response, in milliseconds.' },
  mock_only: {
    type: 'boolean',
    description: "Don't call the real server at all; needs a body. Use when the endpoint doesn't exist yet."
  },
  enabled: { type: 'boolean', description: 'Whether the override is on. Defaults to true for new overrides.' },
  group: {
    type: ['string', 'null'],
    description:
      'Group id, or a group path like "Checkout / Errors" (created if missing). null puts it at the top level.'
  },
  after: {
    type: ['string', 'null'],
    description:
      'Id or name of another override: this one only applies after that one has answered a request on the page, then wins over plain overrides for the same URL. null clears it.'
  }
};

const TOOLS = [
  {
    name: 'doppel_status',
    description:
      'Where the Doppel file is, whether overrides are switched on, and how many there are. Call this first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => {
      const st = load();
      return {
        file: st.path,
        enabled: st.enabled,
        overrides: st.rules.length,
        active: ordered(st).filter((r) => summary(st, r).active).length,
        groups: st.groups.length,
        saved_at: st.data.savedAt ? new Date(st.data.savedAt).toISOString() : null,
        note: 'Doppel picks up changes on the next page load (or within ~30s). Reload the page to see a new override.'
      };
    }
  },
  {
    name: 'list_overrides',
    description:
      'List overrides in priority order (the first matching enabled one wins). Bodies are left out; use get_override to see one.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Only overrides whose name or pattern contains this text.' },
        group: { type: 'string', description: 'Only overrides inside this group (id or path), including subgroups.' }
      }
    },
    annotations: { readOnlyHint: true },
    run: (a) => {
      const st = load();
      let list = ordered(st);
      if (a.group) {
        const id = findGroup(st, a.group)?.id;
        if (!id) throw new UserError(`No group "${a.group}".`);
        const ids = T.descendantIds(st.groups, id);
        list = list.filter((r) => ids.has(T.groupOf(st.groups, r)));
      }
      if (a.search) {
        const q = a.search.toLowerCase();
        list = list.filter((r) => (r.name || '').toLowerCase().includes(q) || r.pattern.toLowerCase().includes(q));
      }
      return { enabled: st.enabled, overrides: list.map((r) => summary(st, r)) };
    }
  },
  {
    name: 'get_override',
    description: 'Full details of one override, including its response body.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Override id or exact name.' } },
      required: ['id']
    },
    annotations: { readOnlyHint: true },
    run: (a) => {
      const st = load();
      const r = findOne(st.rules, a.id, 'override');
      let body = r.body || '';
      try {
        body = body.trim() ? JSON.parse(body) : null;
      } catch (_) {}
      return { ...summary(st, r), body };
    }
  },
  {
    name: 'add_override',
    description:
      "Add a mocked response. It goes to the top of its group, so it beats existing overrides there. Give at least a status or a body. Doppel applies it on the user's next page load.",
    inputSchema: { type: 'object', properties: RULE_FIELDS, required: ['pattern'] },
    run: (a) => {
      const st = load();
      if (a.status == null && (a.body == null || a.body === '') && !a.delay_ms)
        throw new UserError('Give a status, a body or a delay — otherwise the override does nothing.');
      const now = Date.now();
      const rule = {
        id: uid(),
        name: '',
        enabled: true,
        method: 'ANY',
        matchType: 'contains',
        pattern: '',
        ignoreQuery: false,
        status: null,
        body: '',
        delay: 0,
        mockOnly: false,
        groupId: null,
        createdAt: now,
        updatedAt: now
      };
      applyFields(st, rule, a);
      rule.groupId = a.group === undefined ? null : resolveGroup(st, a.group);
      const placed = T.placeItem(
        [rule, ...st.rules],
        st.groups,
        { type: 'r', id: rule.id },
        {
          parentId: rule.groupId,
          index: 0
        }
      );
      st.rules = placed.rules;
      st.groups = placed.groups;
      save(st);
      const saved = st.rules.find((r) => r.id === rule.id);
      return { added: summary(st, saved), ...(st.enabled ? {} : { warning: 'Doppel is switched off globally.' }) };
    }
  },
  {
    name: 'update_override',
    description: 'Change fields of an existing override. Only the fields you pass change.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Override id or exact name.' }, ...RULE_FIELDS },
      required: ['id']
    },
    run: (a) => {
      const st = load();
      const cur = findOne(st.rules, a.id, 'override');
      const rule = { ...cur, updatedAt: Date.now() };
      applyFields(st, rule, a);
      st.rules = st.rules.map((r) => (r.id === cur.id ? rule : r));
      if (a.group !== undefined) {
        const gid = resolveGroup(st, a.group);
        if (gid !== T.groupOf(st.groups, cur)) {
          rule.groupId = gid;
          const placed = T.placeItem(st.rules, st.groups, { type: 'r', id: rule.id }, { parentId: gid, index: 0 });
          st.rules = placed.rules;
          st.groups = placed.groups;
        }
      }
      save(st);
      return {
        updated: summary(
          st,
          st.rules.find((r) => r.id === cur.id)
        )
      };
    }
  },
  {
    name: 'delete_override',
    description: 'Delete an override. To keep it but stop it applying, use set_enabled instead.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Override id or exact name.' } },
      required: ['id']
    },
    annotations: { destructiveHint: true },
    run: (a) => {
      const st = load();
      const r = findOne(st.rules, a.id, 'override');
      st.rules = st.rules.filter((x) => x.id !== r.id);
      const waiting = st.rules.filter((x) => x.after === r.id).map((x) => x.name || x.id);
      save(st);
      return {
        deleted: { id: r.id, name: r.name || '' },
        ...(waiting.length
          ? { warning: `These overrides waited for it and will now never apply: ${waiting.join(', ')}` }
          : {})
      };
    }
  },
  {
    name: 'list_groups',
    description: 'List groups with their paths, whether they are on, and how many overrides they hold.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => {
      const st = load();
      return {
        groups: T.flatGroups(st.groups).map(({ group: g }) => ({
          id: g.id,
          path: groupPath(st.groups, g.id),
          enabled: g.enabled !== false,
          ...T.counts(st.rules, st.groups, g.id)
        }))
      };
    }
  },
  {
    name: 'set_enabled',
    description:
      'Switch something on or off: an override (id or name), a group (id or path), or — with no target — Doppel as a whole.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Override id/name or group id/path. Omit for the global switch.' },
        enabled: { type: 'boolean' }
      },
      required: ['enabled']
    },
    run: (a) => {
      const st = load();
      const on = !!a.enabled;
      let what;
      if (!a.target) {
        st.enabled = on;
        what = { global: true };
      } else {
        const g = findGroup(st, a.target);
        if (g) {
          st.groups = st.groups.map((x) => (x.id === g.id ? { ...x, enabled: on, updatedAt: Date.now() } : x));
          what = { group: { id: g.id, path: groupPath(st.groups, g.id) } };
        } else {
          const r = findOne(st.rules, a.target, 'override');
          st.rules = st.rules.map((x) => (x.id === r.id ? { ...x, enabled: on, updatedAt: Date.now() } : x));
          what = { override: { id: r.id, name: r.name || '' } };
        }
      }
      save(st);
      return { ...what, enabled: on };
    }
  }
];

const INSTRUCTIONS = `Doppel is a Chrome extension that overrides the status code and JSON body of a web page's API responses.
These tools edit the doppel.json file that Doppel syncs with. Changes reach the browser on the next page load, so
tell the user to reload the page after adding or changing an override. When the user describes a mock in words,
build the JSON body yourself and pass it as a value. Prefer match_type "contains" with a distinctive path.
Overrides are checked top to bottom and the first enabled match wins; add_override puts new ones at the top.`;

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'doppel', title: 'Doppel', version: pkg.version },
        instructions: INSTRUCTIONS
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run: _run, ...t }) => t) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
      try {
        const out = await tool.run(params.arguments || {});
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined;
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
