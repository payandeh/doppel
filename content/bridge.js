// Rules stay in the isolated world; a page only ever receives the rule matching its own request.
(() => {
  const KEY_RULES = 'apiov_rules';
  const KEY_ENABLED = 'apiov_enabled';
  const KEY_GROUPS = 'apiov_groups';
  let enabled = true;
  let active = [];
  let loaded = false;

  const emit = (type, data) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));

  function announce() {
    emit('apiov:state', { active: enabled ? active.length : 0 });
  }

  function load() {
    try {
      chrome.storage.local.get([KEY_RULES, KEY_ENABLED, KEY_GROUPS], (d) => {
        enabled = d[KEY_ENABLED] !== false;
        const rules = (Array.isArray(d[KEY_RULES]) ? d[KEY_RULES] : []).filter(Boolean);
        active = APIOV_MATCH.activeRules(rules, Array.isArray(d[KEY_GROUPS]) ? d[KEY_GROUPS] : []);
        loaded = true;
        announce();
      });
    } catch (_) {}
  }

  document.addEventListener('apiov:request-state', () => {
    if (loaded) announce();
  });

  document.addEventListener('apiov:match', (e) => {
    let q;
    try {
      q = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (!q || typeof q.url !== 'string') return;
    const rule = enabled ? APIOV_MATCH.findRule(active, q.url, q.method) : null;
    emit('apiov:match-result', { id: q.id, rule });
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[KEY_RULES] || changes[KEY_ENABLED] || changes[KEY_GROUPS])) load();
    });
  } catch (_) {}

  load();
})();
