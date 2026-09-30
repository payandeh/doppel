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

  g.APIOV_MATCH = { matches, findRule, stripQuery };
})(globalThis);
