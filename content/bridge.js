// Rules stay in the isolated world; a page only ever receives the rule matching its own request.
(() => {
  const KEY_RULES = 'apiov_rules';
  const KEY_ENABLED = 'apiov_enabled';
  const KEY_GROUPS = 'apiov_groups';
  let enabled = true;
  let active = [];
  let loaded = false;
  let native = false; // the network layer (debugger) applies overrides for this frame instead of the page patch

  const emit = (type, data) => document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(data) }));

  function announce() {
    emit('apiov:state', { active: enabled ? active.length : 0, native });
  }

  const askNative = () =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'apiov:native?' }, (r) => {
          void chrome.runtime.lastError;
          resolve(!!(r && r.on));
        });
      } catch (_) {
        resolve(false);
      }
    });

  function load() {
    try {
      const rulesP = new Promise((resolve) =>
        chrome.storage.local.get([KEY_RULES, KEY_ENABLED, KEY_GROUPS], (d) => {
          enabled = d[KEY_ENABLED] !== false;
          const rules = (Array.isArray(d[KEY_RULES]) ? d[KEY_RULES] : []).filter(Boolean);
          active = APIOV_MATCH.activeRules(rules, Array.isArray(d[KEY_GROUPS]) ? d[KEY_GROUPS] : []);
          resolve();
        })
      );
      Promise.all([rulesP, loaded ? null : askNative().then((on) => (native = on))]).then(() => {
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

  // Tell the extension (Doppel's DevTools tab) what the page actually received.
  document.addEventListener('apiov:applied', (e) => {
    try {
      chrome.runtime.sendMessage({ type: 'apiov:applied', rec: JSON.parse(e.detail) }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  });

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'apiov:native' && window === window.top) {
        native = !!msg.on;
        if (loaded) announce();
      }
    });
  } catch (_) {}

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[KEY_RULES] || changes[KEY_ENABLED] || changes[KEY_GROUPS])) load();
    });
  } catch (_) {}

  load();
})();
