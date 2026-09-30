function mountRulesView(root, { compact = false, onEdit } = {}) {
  const { esc, statusClass } = APIOV;
  const edit = onEdit || ((rule) => openRuleEditor({ rule }));

  root.innerHTML = `
    <div class="rules-toolbar">
      <label class="switch-label"><span class="switch"><input type="checkbox" data-global><i></i></span> <b>Overrides ${'<span data-global-text></span>'}</b></label>
      <input class="search" type="search" placeholder="Filter overrides…">
      <div class="spacer"></div>
      ${
        compact
          ? ''
          : `
      <button class="btn" data-act="import">Import</button>
      <button class="btn" data-act="export">Export</button>`
      }
      <button class="btn primary" data-act="new">+ New override</button>
      <input type="file" accept="application/json,.json" hidden>
    </div>
    <p class="order-hint">When several overrides match the same request, the one higher in the list wins.</p>
    <ul class="rules"></ul>`;

  const list = root.querySelector('.rules');
  const globalEl = root.querySelector('[data-global]');
  const globalText = root.querySelector('[data-global-text]');
  const search = root.querySelector('.search');
  const fileInput = root.querySelector('input[type=file]');
  let current = { rules: [], enabled: true };

  function render() {
    const { rules, enabled } = current;
    globalEl.checked = enabled;
    globalText.textContent = enabled ? 'on' : 'off';
    root.classList.toggle('globally-off', !enabled);
    const q = search.value.trim().toLowerCase();
    const shown = rules.filter(
      (r) => !q || (r.pattern + ' ' + (r.name || '') + ' ' + r.method).toLowerCase().includes(q)
    );
    if (!rules.length) {
      list.innerHTML = `<li class="empty">
        <b>No overrides yet.</b><br>
        Open DevTools → <b>Network</b>, right-click a request and choose <b>Open using Doppel</b>,
        or click <b>+ New override</b>.</li>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = '<li class="empty">No overrides match the filter.</li>';
      return;
    }
    list.innerHTML = shown
      .map((r) => {
        const idx = rules.indexOf(r);
        const u = splitPattern(r);
        const hasBody = !!(r.body && r.body.trim());
        return `
      <li class="rule ${r.enabled ? '' : 'disabled'}" data-id="${r.id}">
        <div class="rc-top">
          <label class="switch" title="${r.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}><i></i></label>
          <span class="method m-${esc(r.method)}">${esc(r.method)}</span>
          <span class="rc-name ${r.name ? '' : 'muted'}" title="${esc(r.name || 'Untitled override')}">${esc(r.name || 'Untitled override')}</span>
          <span class="rc-tags">
            <span class="tag ${statusClass(r.status)}">${r.status ? 'status ' + r.status : 'status: original'}</span>
            <span class="tag ${hasBody ? 'tag-on' : ''}">${hasBody ? 'body: custom' : 'body: original'}</span>
            <span class="tag">${esc(r.matchType)}${r.matchType === 'equals' && r.ignoreQuery ? ', no query' : ''}</span>
            ${r.delay ? `<span class="tag">+${r.delay}ms</span>` : ''}
            ${r.mockOnly ? '<span class="tag tag-on">mock only</span>' : ''}
          </span>
        </div>
        <div class="rc-url" data-act="edit" title="${esc(r.pattern)}">
          <div class="rc-row"><span class="rc-label">${esc(u.hostLabel)}</span>
            <span class="rc-host mono">${u.scheme ? `<span class="muted">${esc(u.scheme)}</span>` : ''}${esc(u.host)}</span></div>
          <div class="rc-row"><span class="rc-label">${esc(u.routeLabel)}</span>
            <span class="rc-route mono">${esc(u.route)}</span></div>
        </div>
        <div class="rc-actions">
          <button class="abtn a-edit" data-act="edit">Edit</button>
          <button class="abtn a-dup" data-act="dup">Duplicate</button>
          ${
            compact
              ? ''
              : `
          <button class="abtn a-move" data-act="up" ${idx === 0 ? 'disabled' : ''}>Move up</button>
          <button class="abtn a-move" data-act="down" ${idx === rules.length - 1 ? 'disabled' : ''}>Move down</button>`
          }
          <span class="spacer"></span>
          <button class="abtn a-delete" data-act="delete">Delete</button>
        </div>
      </li>`;
      })
      .join('');
  }

  function splitPattern(r) {
    const p = (r.pattern || '').trim();
    const m = r.matchType !== 'regex' && /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(p);
    if (m) return { hostLabel: 'Host', scheme: m[1], host: m[2], routeLabel: 'Route', route: m[3] || '/' };
    if (r.matchType === 'regex')
      return { hostLabel: 'Match', scheme: '', host: 'Regular expression', routeLabel: 'Pattern', route: p };
    return {
      hostLabel: 'Host',
      scheme: '',
      host: r.matchType === 'contains' ? 'Any (URL contains)' : 'Any host',
      routeLabel: 'Route',
      route: p
    };
  }

  async function refresh() {
    current = await APIOV.load();
    render();
  }
  APIOV.onChange((d) => {
    current = d;
    render();
  });
  search.addEventListener('input', render);
  globalEl.addEventListener('change', () => APIOV.setEnabled(globalEl.checked));

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act === 'toggle') return;
    const act = el.dataset.act;
    const id = el.closest('[data-id]')?.dataset.id;
    const rule = current.rules.find((r) => r.id === id);
    if (act === 'new') return edit(APIOV.newRule(), true);
    if (act === 'edit' && rule) return edit(rule, false);
    if (act === 'delete' && rule) {
      if (
        await APIOV.confirmDialog(`Delete override for ${rule.method} ${rule.pattern}?`, {
          okText: 'Delete',
          danger: true
        })
      )
        await APIOV.remove(id);
    }
    if (act === 'dup') await APIOV.duplicate(id);
    if (act === 'up') await APIOV.move(id, -1);
    if (act === 'down') await APIOV.move(id, 1);
    if (act === 'export') {
      const blob = new Blob([JSON.stringify({ version: 1, rules: current.rules }, null, 2)], {
        type: 'application/json'
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'doppel-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    if (act === 'import') fileInput.click();
  });

  root.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'toggle') {
      APIOV.toggle(e.target.closest('[data-id]').dataset.id, e.target.checked);
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.rules || []).filter((r) => r && r.pattern);
      if (!incoming.length) throw new Error('No overrides found in file');
      const { rules } = await APIOV.load();
      const ids = new Set(rules.map((r) => r.id));
      const fresh = incoming.map((r) => APIOV.newRule({ ...r, id: ids.has(r.id) || !r.id ? APIOV.uid() : r.id }));
      await APIOV.saveRules([...fresh, ...rules]);
      APIOV.toast(`Imported ${fresh.length} override(s)`);
    } catch (err) {
      APIOV.toast('Import failed: ' + err.message);
    }
  });

  refresh();
  return {
    refresh,
    get state() {
      return current;
    }
  };
}
