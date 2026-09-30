(function (g) {
  const cache = new Map();
  function re(kind, src) {
    const key = kind + '\u0000' + src;
    let r = cache.get(key);
    if (r === undefined) {
      try {
        r =
          kind === 'regex'
            ? new RegExp(src)
            : new RegExp(
                '^' +
                  src
                    .split('*')
                    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                    .join('.*') +
                  '$'
              );
      } catch (_) {
        r = null;
      }
      if (cache.size > 500) cache.clear();
      cache.set(key, r);
    }
    return r;
  }

  const stripQuery = (u) => {
    const i = u.search(/[?#]/);
    return i < 0 ? u : u.slice(0, i);
  };

  function matches(rule, url, method) {
    method = String(method || 'GET').toUpperCase();
    if (rule.method && rule.method !== 'ANY' && rule.method !== method) return false;
    const p = (rule.pattern || '').trim();
    if (!p) return false;
    switch (rule.matchType) {
      case 'contains':
        return url.includes(p);
      case 'wildcard': {
        const r = re('wildcard', p);
        return !!r && r.test(url);
      }
      case 'regex': {
        const r = re('regex', p);
        return !!r && r.test(url);
      }
      default:
        return rule.ignoreQuery ? stripQuery(url) === stripQuery(p) : url === p;
    }
  }

  function findRule(rules, url, method, includeDisabled = false) {
    for (const r of rules) if ((includeDisabled || r.enabled) && matches(r, url, method)) return r;
    return null;
  }

  function sortSiblings(groups, rules) {
    const key = (x, i, base) => (typeof x.sort === 'number' ? x.sort : base + i);
    return [
      ...groups.map((item, i) => ({ type: 'g', item, k: key(item, i, -2e6) })),
      ...rules.map((item, i) => ({ type: 'r', item, k: key(item, i, -1e6) }))
    ]
      .map((c, i) => ({ ...c, i }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map(({ type, item }) => ({ type, item }));
  }

  function ordered(rules, groups = []) {
    const ids = new Set(groups.map((x) => x.id));
    const parent = new Map(groups.map((x) => [x.id, ids.has(x.parentId) ? x.parentId : null]));
    const kids = new Map();
    const bucket = (k) => kids.get(k) || kids.set(k, { g: [], r: [] }).get(k);
    for (const x of groups) bucket(parent.get(x.id)).g.push(x);
    for (const r of rules) bucket(ids.has(r.groupId) ? r.groupId : null).r.push(r);
    const out = [];
    const seen = new Set();
    const walk = (id, on) => {
      const b = kids.get(id);
      if (!b) return;
      for (const c of sortSiblings(b.g, b.r)) {
        if (c.type === 'r') out.push({ rule: c.item, on });
        else if (!seen.has(c.item.id)) {
          seen.add(c.item.id);
          walk(c.item.id, on && c.item.enabled !== false);
        }
      }
    };
    walk(null, true);
    for (const x of groups)
      if (!seen.has(x.id)) {
        seen.add(x.id);
        walk(x.id, x.enabled !== false);
      }
    return out;
  }

  const inOrder = (rules, groups) => ordered(rules, groups).map((e) => e.rule);
  const activeRules = (rules, groups) =>
    ordered(rules, groups)
      .filter((e) => e.on && e.rule.enabled)
      .map((e) => e.rule);

  g.APIOV_MATCH = { matches, findRule, stripQuery, sortSiblings, inOrder, activeRules };
})(globalThis);
