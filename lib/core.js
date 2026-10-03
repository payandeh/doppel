const APIOV = (() => {
  const KEY_RULES = 'apiov_rules';
  const KEY_ENABLED = 'apiov_enabled';
  const KEY_GROUPS = 'apiov_groups';
  const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const MATCH_TYPES = [
    ['equals', 'Equals'],
    ['contains', 'Contains'],
    ['wildcard', 'Wildcard (*)'],
    ['regex', 'Regex']
  ];

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const { matches, findRule, inOrder, activeRules } = APIOV_MATCH;

  async function load() {
    const d = await chrome.storage.local.get([KEY_RULES, KEY_ENABLED, KEY_GROUPS]);
    return {
      rules: Array.isArray(d[KEY_RULES]) ? d[KEY_RULES] : [],
      groups: Array.isArray(d[KEY_GROUPS]) ? d[KEY_GROUPS] : [],
      enabled: d[KEY_ENABLED] !== false
    };
  }
  const saveRules = (rules) => chrome.storage.local.set({ [KEY_RULES]: rules, apiov_rev: Date.now() + Math.random() });
  const saveState = ({ rules, groups }) =>
    chrome.storage.local.set({ [KEY_RULES]: rules, [KEY_GROUPS]: groups, apiov_rev: Date.now() + Math.random() });
  async function mutate(fn) {
    const cur = await load();
    const next = fn(cur);
    if (next) await saveState({ rules: next.rules || cur.rules, groups: next.groups || cur.groups });
    return next;
  }
  const setEnabled = (v) => chrome.storage.local.set({ [KEY_ENABLED]: !!v, apiov_rev: Date.now() + Math.random() });

  async function upsert(rule) {
    rule.updatedAt = Date.now();
    await mutate(({ rules, groups }) => {
      const T = APIOV_TREE;
      const i = rules.findIndex((r) => r.id === rule.id);
      const prev = i >= 0 ? rules[i] : null;
      const next = prev ? rules.map((r, k) => (k === i ? rule : r)) : [rule, ...rules];
      const gid = T.groupOf(groups, rule);
      if (prev && T.groupOf(groups, prev) === gid) return { rules: next };
      return T.placeItem(next, groups, { type: 'r', id: rule.id }, { parentId: gid, index: 0 });
    });
  }
  async function remove(id) {
    const { rules } = await load();
    await saveRules(rules.filter((r) => r.id !== id));
  }
  async function toggle(id, on) {
    const { rules } = await load();
    const r = rules.find((x) => x.id === id);
    if (r) {
      r.enabled = on;
      r.updatedAt = Date.now();
      await saveRules(rules);
    }
  }
  const duplicate = (id, name) =>
    mutate(({ rules, groups }) => {
      const T = APIOV_TREE;
      const i = rules.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const copy = {
        ...rules[i],
        id: uid(),
        name: typeof name === 'string' ? name.trim() : (rules[i].name || '') + ' (copy)',
        enabled: false,
        createdAt: Date.now()
      };
      const ref = { type: 'r', id };
      const at = { parentId: T.containerOf(rules, groups, ref), index: T.indexIn(rules, groups, ref) + 1 };
      return T.placeItem(
        [...rules.slice(0, i + 1), copy, ...rules.slice(i + 1)],
        groups,
        { type: 'r', id: copy.id },
        at
      );
    });
  const shift = (ref, dir) => mutate(({ rules, groups }) => APIOV_TREE.shiftItem(rules, groups, ref, dir));
  const move = (id, dir) => shift({ type: 'r', id }, dir);
  const toTop = (ref) => mutate(({ rules, groups }) => APIOV_TREE.toTop(rules, groups, ref));
  const place = (ref, at) => mutate(({ rules, groups }) => APIOV_TREE.placeItem(rules, groups, ref, at));

  function newGroup(p = {}) {
    return APIOV_TREE.normalizeGroup({
      id: uid(),
      name: 'New group',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...p
    });
  }
  const addGroup = (group) =>
    mutate(({ rules, groups }) =>
      APIOV_TREE.placeItem(
        rules,
        [...groups, group],
        { type: 'g', id: group.id },
        { parentId: group.parentId, index: 0 }
      )
    );
  const updateGroup = (id, patch) =>
    mutate(({ groups }) => ({
      groups: groups.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x))
    }));

  function onChange(cb) {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'local' && (c[KEY_RULES] || c[KEY_ENABLED] || c[KEY_GROUPS])) load().then(cb);
    });
  }

  function download(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'group';

  let closeOpenMenu = null;
  function menu(anchor, items) {
    if (closeOpenMenu) closeOpenMenu();
    const el = document.createElement('div');
    el.className = 'dmenu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items
      .map((it, i) =>
        it === '-'
          ? '<hr>'
          : it.heading
            ? `<div class="dmenu-head">${esc(it.heading)}</div>`
            : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''} ${it.current ? 'current' : ''}" ${
                it.disabled ? 'disabled' : ''
              } style="padding-left:${10 + (it.depth || 0) * 14}px">${it.icon ? `<span class="dmenu-ic">${it.icon}</span>` : ''}${esc(it.label)}</button>`
      )
      .join('');
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth,
      h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(r.right - w, innerWidth - w - 4)) + 'px';
    el.style.top = (r.bottom + h + 4 > innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4) + 'px';
    const close = () => {
      el.remove();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      closeOpenMenu = null;
    };
    const outside = (e) => {
      if (!el.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...el.querySelectorAll('button:not(:disabled)')];
        const i = btns.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
        btns[(i + btns.length) % btns.length]?.focus();
      }
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      close();
      items[+b.dataset.i].run();
    });
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    closeOpenMenu = close;
    el.querySelector('button:not(:disabled)')?.focus();
  }

  function newRule(p = {}) {
    return {
      id: uid(),
      name: '',
      enabled: true,
      method: 'ANY',
      matchType: 'equals',
      pattern: '',
      ignoreQuery: false,
      status: null,
      body: '',
      delay: 0,
      mockOnly: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...p
    };
  }

  function prettyJson(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return null;
    }
  }

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  function shortUrl(u) {
    try {
      const x = new URL(u);
      return x.pathname + x.search;
    } catch (_) {
      return u;
    }
  }

  function statusClass(s) {
    if (!s) return 's-none';
    if (s >= 500) return 's-5xx';
    if (s >= 400) return 's-4xx';
    if (s >= 300) return 's-3xx';
    return 's-2xx';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // Native confirm() is unreliable in extension popups and DevTools panels.
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
      const done = (v) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          done(true);
        }
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

  // Text-input dialog (like an IDE's "Copy class" prompt). Resolves to the entered string, or null on cancel.
  function promptDialog(title, { label = 'Name', value = '', subtitle = '', placeholder = '', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back confirm-back';
      back.innerHTML = `<div class="modal confirm prompt" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-body">
          <h3 class="confirm-title">${esc(title)}</h3>
          ${subtitle ? `<p class="confirm-msg prompt-sub"></p>` : ''}
          <label class="field"><span>${esc(label)}</span>
            <input class="prompt-input" type="text" spellcheck="false" placeholder="${esc(placeholder)}"></label>
        </div>
        <footer><div class="spacer"></div>
          <button class="btn" data-v="0">Cancel</button>
          <button class="btn primary" data-v="1">${esc(okText)}</button></footer></div>`;
      if (subtitle) back.querySelector('.prompt-sub').textContent = subtitle;
      const input = back.querySelector('.prompt-input');
      input.value = value;
      const done = (ok) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(ok ? input.value : null);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          done(true);
        }
      };
      back.addEventListener('click', (e) => {
        if (e.target === back) return done(false);
        const v = e.target.closest('[data-v]');
        if (v) done(v.dataset.v === '1');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      input.focus();
      input.select();
    });
  }

  function choiceDialog(message, choices, { title = '' } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back confirm-back';
      back.innerHTML = `<div class="modal confirm wide" role="alertdialog">
        <div class="modal-body">${title ? `<h3 class="confirm-title">${esc(title)}</h3>` : ''}<p class="confirm-msg"></p></div>
        <footer><div class="spacer"></div>${choices
          .map((c, i) => `<button class="btn ${c.kind || ''}" data-i="${i}">${esc(c.label)}</button>`)
          .join('')}</footer></div>`;
      back.querySelector('.confirm-msg').textContent = message;
      const done = (v) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(null);
        }
      };
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
    confirmDialog,
    promptDialog,
    METHODS,
    MATCH_TYPES,
    uid,
    matches,
    findRule,
    inOrder,
    activeRules,
    load,
    saveRules,
    saveState,
    mutate,
    newGroup,
    addGroup,
    updateGroup,
    download,
    slug,
    menu,
    setEnabled,
    upsert,
    remove,
    toggle,
    duplicate,
    move,
    shift,
    toTop,
    place,
    onChange,
    newRule,
    prettyJson,
    esc,
    shortUrl,
    statusClass,
    copyText,
    toast
  };
})();
