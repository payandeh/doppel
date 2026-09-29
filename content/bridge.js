// Runs in the extension's isolated world. Rules never leave this world:
// the page script asks "does anything match this URL + method?" synchronously
// and only receives the one matching rule (so other sites can't read your mocks).
(() => {
  const KEY_RULES = 'apiov_rules';
  const KEY_ENABLED = 'apiov_enabled';
  let enabled = true;
  let active = [];
  let loaded = false;

  const emit = (type, data) =>
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));

  function announce() {
    emit('apiov:state', { active: enabled ? active.length : 0 });
  }

  function load() {
    try {
      chrome.storage.local.get([KEY_RULES, KEY_ENABLED], (d) => {
        enabled = d[KEY_ENABLED] !== false;
        active = (Array.isArray(d[KEY_RULES]) ? d[KEY_RULES] : []).filter((r) => r && r.enabled);
        loaded = true;
        announce();
      });
    } catch (_) { /* extension was reloaded — this script is orphaned */ }
  }

  document.addEventListener('apiov:request-state', () => { if (loaded) announce(); });

  document.addEventListener('apiov:match', (e) => {
    let q;
    try { q = JSON.parse(e.detail); } catch (_) { return; }
    if (!q || typeof q.url !== 'string') return;
    const rule = enabled ? APIOV_MATCH.findRule(active, q.url, q.method) : null;
    emit('apiov:match-result', { id: q.id, rule });
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[KEY_RULES] || changes[KEY_ENABLED])) load();
    });
  } catch (_) {}

  load();
})();
