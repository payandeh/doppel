// Shared helpers for extension pages (popup, manager, DevTools panel).
const APIOV = (() => {
  const KEY_RULES = 'apiov_rules';
  const KEY_ENABLED = 'apiov_enabled';
  const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const MATCH_TYPES = [
    ['equals', 'Equals'],
    ['contains', 'Contains'],
    ['wildcard', 'Wildcard (*)'],
    ['regex', 'Regex']
  ];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const { matches, findRule } = APIOV_MATCH;

  async function load() {
    const d = await chrome.storage.local.get([KEY_RULES, KEY_ENABLED]);
    return { rules: Array.isArray(d[KEY_RULES]) ? d[KEY_RULES] : [], enabled: d[KEY_ENABLED] !== false };
  }
  const saveRules = (rules) => chrome.storage.local.set({ [KEY_RULES]: rules, apiov_rev: Date.now() + Math.random() });
  const setEnabled = (v) => chrome.storage.local.set({ [KEY_ENABLED]: !!v, apiov_rev: Date.now() + Math.random() });

  async function upsert(rule) {
    const { rules } = await load();
    rule.updatedAt = Date.now();
    const i = rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) rules[i] = rule; else rules.unshift(rule);
    await saveRules(rules);
  }
  async function remove(id) {
    const { rules } = await load();
    await saveRules(rules.filter((r) => r.id !== id));
  }
  async function toggle(id, on) {
    const { rules } = await load();
    const r = rules.find((x) => x.id === id);
    if (r) { r.enabled = on; r.updatedAt = Date.now(); await saveRules(rules); }
  }
  async function duplicate(id) {
    const { rules } = await load();
    const i = rules.findIndex((x) => x.id === id);
    if (i < 0) return;
    const copy = { ...rules[i], id: uid(), name: (rules[i].name || '') + ' (copy)', enabled: false, createdAt: Date.now() };
    rules.splice(i + 1, 0, copy);
    await saveRules(rules);
  }
  async function move(id, dir) {
    const { rules } = await load();
    const i = rules.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= rules.length) return;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    await saveRules(rules);
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && (c[KEY_RULES] || c[KEY_ENABLED])) load().then(cb);
    });
  }

  function newRule(p = {}) {
    return {
      id: uid(), name: '', enabled: true, method: 'ANY', matchType: 'equals', pattern: '',
      ignoreQuery: false, status: null, body: '', delay: 0, mockOnly: false,
      createdAt: Date.now(), updatedAt: Date.now(), ...p
    };
  }

  function prettyJson(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return null; }
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function shortUrl(u) {
    try { const x = new URL(u); return x.pathname + x.search; } catch (_) { return u; }
  }

  function statusClass(s) {
    if (!s) return 's-none';
    if (s >= 500) return 's-5xx';
    if (s >= 400) return 's-4xx';
    if (s >= 300) return 's-3xx';
    return 's-2xx';
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // In-page confirm dialog (native confirm() is unreliable in popups / DevTools panels)
  function confirmDialog(message, { okText = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back confirm-back';
      back.innerHTML = `<div class="modal confirm" role="alertdialog">
        <div class="modal-body"><p class="confirm-msg"></p></div>
        <footer><div class="spacer"></div>
          <button class="btn" data-v="0">Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-v="1">${esc(okText)}</button></footer></div>`;
      back.querySelector('.confirm-msg').textContent = message;
      const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      back.addEventListener('click', (e) => {
        if (e.target === back) return done(false);
        const v = e.target.closest('[data-v]');
        if (v) done(v.dataset.v === '1');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      back.querySelector('[data-v="1"]').focus();
    });
  }

  // Dialog with several choices: choices = [{ value, label, kind: 'primary'|'danger'|'' }]
  function choiceDialog(message, choices, { title = '' } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back confirm-back';
      back.innerHTML = `<div class="modal confirm wide" role="alertdialog">
        <div class="modal-body">${title ? `<h3 class="confirm-title">${esc(title)}</h3>` : ''}<p class="confirm-msg"></p></div>
        <footer><div class="spacer"></div>${choices.map((c, i) =>
          `<button class="btn ${c.kind || ''}" data-i="${i}">${esc(c.label)}</button>`).join('')}</footer></div>`;
      back.querySelector('.confirm-msg').textContent = message;
      const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } };
      back.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) done(choices[+b.dataset.i].value);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
    });
  }

  return {
    choiceDialog,
    confirmDialog, METHODS, MATCH_TYPES, uid, matches, findRule, load, saveRules, setEnabled, upsert, remove,
    toggle, duplicate, move, onChange, newRule, prettyJson, esc, shortUrl, statusClass, copyText, toast
  };
})();
