(() => {
  const { esc, statusClass, findRule, shortUrl } = APIOV;
  const $ = (id) => document.getElementById(id);

  try {
    document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';
  } catch (_) {}

  let items = [];
  let nextId = 1;
  let selectedId = null;
  let state = { rules: [], groups: [], enabled: true };
  let ordered = [];
  let active = [];

  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.view').forEach((v) => {
        v.hidden = v.id !== t.dataset.tab;
      });
    })
  );

  mountRulesView($('rules'), { onEdit: (rule, isNew) => openRuleEditor({ rule, isNew }) });

  function applyState(s) {
    state = s;
    ordered = APIOV.inOrder(s.rules, s.groups);
    active = APIOV.activeRules(s.rules, s.groups);
    $('ovr-count').textContent = s.rules.length ? active.length + '/' + s.rules.length : '';
    $('global-off').hidden = s.enabled;
    renderRows();
  }
  APIOV.load().then(applyState);
  APIOV.onChange(applyState);

  const typeOf = (req) => req._resourceType || (req.response.content.mimeType || '').split('/').pop() || '';
  const isApi = (req) => {
    const t = req._resourceType;
    if (t === 'xhr' || t === 'fetch') return true;
    return /json/i.test(req.response?.content?.mimeType || '');
  };
  function nameOf(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.split('/').filter(Boolean).pop() || u.host;
      return seg + u.search;
    } catch (_) {
      return url;
    }
  }
  function fmtSize(req) {
    const n = req.response._transferSize > 0 ? req.response._transferSize : req.response.content.size;
    if (!(n >= 0)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  const fmtTime = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : Math.round(ms) + ' ms');

  function getContent(req) {
    return new Promise((resolve) => {
      try {
        req.getContent((content, encoding) => {
          if (content && encoding === 'base64') {
            try {
              const bin = atob(content);
              const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
              content = new TextDecoder().decode(bytes);
            } catch (_) {}
          }
          resolve(content || '');
        });
      } catch (_) {
        resolve('');
      }
    });
  }

  // ---- What the page actually received (reported by Doppel for overridden requests) ----
  const noHash = (u) => String(u).split('#')[0];
  const sameReq = (req, rec) =>
    noHash(req.request.url) === noHash(rec.url) && req.request.method.toUpperCase() === rec.method.toUpperCase();
  let pending = [];

  function mockedReq(rec) {
    const body = rec.body || '';
    return {
      _doppel: true,
      _resourceType: rec.kind || 'fetch',
      request: { url: rec.url, method: rec.method },
      response: { status: rec.status, content: { mimeType: 'application/json', size: body.length }, _transferSize: 0 },
      time: 0,
      getContent: (cb) => cb(body, '')
    };
  }

  function refreshRow(item) {
    const tr = document.querySelector(`#rows tr[data-id="${item.id}"]`);
    if (tr) tr.outerHTML = rowHtml(item);
    if (selectedId === item.id) openPreview(item);
  }

  function onApplied(rec, quiet) {
    // Mocked by the page patch: nothing went over the network, so Chrome has no entry for it.
    if (rec.via === 'page' && rec.mocked) {
      const item = add(mockedReq(rec), quiet);
      item.applied = rec;
      if (!quiet) refreshRow(item);
      return;
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.applied && !it.req._doppel && sameReq(it.req, rec)) {
        it.applied = rec;
        if (!quiet) refreshRow(it);
        return;
      }
    }
    // The network entry has not finished yet; attach it when it arrives.
    pending = pending.filter((p) => Date.now() - p.at < 60000).slice(-200);
    pending.push(rec);
  }

  function takePending(req) {
    const i = pending.findIndex((rec) => sameReq(req, rec));
    return i < 0 ? null : pending.splice(i, 1)[0];
  }

  function ruleFor(req, includeDisabled) {
    return includeDisabled
      ? findRule(ordered, req.request.url, req.request.method, true)
      : findRule(active, req.request.url, req.request.method);
  }

  function visible(item) {
    const req = item.req;
    if ($('xhrOnly').checked && !isApi(req)) return false;
    const q = $('filter').value.trim().toLowerCase();
    return !q || req.request.url.toLowerCase().includes(q);
  }

  function rowHtml(item) {
    const req = item.req;
    const rule = state.enabled ? ruleFor(req, false) : null;
    const disabledRule = !rule ? ruleFor(req, true) : null;
    const realStatus = req.response.status;
    const ap = item.applied;
    let statusCell = realStatus
      ? `<span class="st ${statusClass(realStatus)}">${realStatus}</span>`
      : '<span class="muted">(failed)</span>';
    if (ap) {
      const from = ap.realStatus;
      statusCell = from ? `<span class="st ${statusClass(from)}">${from}</span>` : '';
      if (!from || from !== ap.status)
        statusCell += `${from ? ' → ' : ''}<span class="st ${statusClass(ap.status)}">${ap.status}</span>`;
      statusCell += ap.mocked
        ? '<span class="pill" title="Mocked by Doppel — no network request was made">mocked</span>'
        : '<span class="pill" title="The page received Doppel\'s override">overridden</span>';
    } else if (rule) {
      if (rule.status) statusCell += ` → <span class="st ${statusClass(rule.status)}">${rule.status}</span>`;
      statusCell += '<span class="pill" title="Response is overridden in the page">overridden</span>';
    } else if (disabledRule) {
      statusCell += '<span class="pill off" title="A matching override exists but is disabled">off</span>';
    }
    return `<tr data-id="${item.id}" class="${rule || ap ? 'ovr' : ''} ${item.id === selectedId ? 'sel' : ''}">
      <td class="c-name" title="${esc(req.request.url)}">${esc(nameOf(req.request.url))}</td>
      <td class="c-method">${esc(req.request.method)}</td>
      <td class="c-status">${statusCell}</td>
      <td class="c-type">${esc(typeOf(req))}</td>
      <td class="c-size">${fmtSize(req)}</td>
      <td class="c-time">${fmtTime(req.time || 0)}</td></tr>`;
  }

  function renderRows() {
    const shown = items.filter(visible);
    $('rows').innerHTML = shown.map(rowHtml).join('');
    $('net-empty').hidden = shown.length > 0;
  }

  function add(req, quiet) {
    const item = { id: nextId++, req };
    if (!req._doppel) item.applied = takePending(req);
    items.push(item);
    if (items.length > 1500) items.shift();
    if (!quiet && visible(item)) {
      const wrap = document.querySelector('.table-wrap');
      const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
      $('rows').insertAdjacentHTML('beforeend', rowHtml(item));
      $('net-empty').hidden = true;
      if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    }
    return item;
  }

  const byId = (id) => items.find((i) => i.id === Number(id));

  ['filter', 'xhrOnly'].forEach((id) => $(id).addEventListener('input', renderRows));
  $('clear').addEventListener('click', () => {
    items = [];
    closePreview();
    renderRows();
  });

  async function openPreview(item) {
    selectedId = item.id;
    document
      .querySelectorAll('#rows tr')
      .forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.id) === item.id));
    const req = item.req;
    $('preview').hidden = false;
    $('pv-title').textContent = `${req.request.method} ${shortUrl(req.request.url)}`;
    $('pv-title').title = req.request.url;
    const rule = ruleFor(req, true);
    $('pv-override').textContent = rule ? 'Edit override' : 'Override API';
    showPreviewMessage('Loading…');
    const { content, note } = await shownContent(item);
    if (selectedId !== item.id) return;
    const pretty = APIOV.prettyJson(content);
    const ap = item.applied;
    const canToggle = !!ap && ap.via === 'page' && ap.body !== undefined && !ap.mocked;
    $('pv-toggle').hidden = !canToggle;
    $('pv-toggle').textContent = item.showReal ? 'Show override' : 'Show real response';
    $('pv-note').textContent = note || (content && !pretty ? 'Not JSON' : '');
    const text = pretty ?? content;
    if (!text) return showPreviewMessage('(no response body)');
    showPreviewText(text.length > 2000000 ? text.slice(0, 2000000) + '\n… (truncated)' : text);
  }
  // The override when Doppel reported one, otherwise what Chrome recorded.
  async function shownContent(item) {
    const ap = item.applied;
    const rule = ruleFor(item.req, true);
    if (ap && ap.mocked) return { content: ap.body || '', note: 'Mocked by Doppel — no network request' };
    if (ap && ap.body !== undefined && !item.showReal)
      return {
        content: ap.body,
        note:
          ap.via === 'network'
            ? 'Overridden (also shown in Chrome’s Network tab)'
            : 'Overridden — what the page received'
      };
    const content = await getContent(item.req);
    if (ap) return { content, note: ap.body !== undefined ? 'Real server response' : 'Status overridden, real body' };
    return {
      content,
      note: rule && active.includes(rule) && state.enabled ? 'Real server response (page gets the override)' : ''
    };
  }

  let viewer = null;
  function showPreviewMessage(msg) {
    if (viewer) {
      viewer.destroy();
      viewer = null;
    }
    $('pv-body').innerHTML = '';
    const d = document.createElement('div');
    d.className = 'pv-msg';
    d.textContent = msg;
    $('pv-body').appendChild(d);
  }
  function showPreviewText(text) {
    if (!viewer) {
      $('pv-body').innerHTML = '';
      viewer = JsonEditor.create({ parent: $('pv-body'), doc: text, readOnly: true });
    } else viewer.setValue(text);
  }
  function closePreview() {
    selectedId = null;
    $('preview').hidden = true;
    document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
  }
  $('pv-close').addEventListener('click', closePreview);
  $('pv-override').addEventListener('click', () => {
    const it = byId(selectedId);
    if (it) overrideFrom(it.req);
  });
  $('pv-toggle').addEventListener('click', () => {
    const it = byId(selectedId);
    if (!it) return;
    it.showReal = !it.showReal;
    openPreview(it);
  });
  $('pv-copy').addEventListener('click', async () => {
    const it = byId(selectedId);
    if (!it) return;
    const { content: c } = await shownContent(it);
    await APIOV.copyText(APIOV.prettyJson(c) ?? c);
    APIOV.toast('Response copied');
  });

  async function overrideFrom(req) {
    const existing = ruleFor(req, true);
    if (existing) return openRuleEditor({ rule: existing, originalStatus: req.response.status || null });
    const content = await getContent(req);
    const body = APIOV.prettyJson(content) ?? content;
    openRuleEditor({
      isNew: true,
      originalStatus: req.response.status || null,
      rule: APIOV.newRule({
        method: req.request.method.toUpperCase(),
        matchType: 'equals',
        pattern: req.request.url,
        status: null,
        body: body || ''
      })
    });
  }

  const rowsEl = $('rows');
  rowsEl.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr) openPreview(byId(tr.dataset.id));
  });
  rowsEl.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (tr) overrideFrom(byId(tr.dataset.id).req);
  });

  const ctx = $('ctx');
  function hideCtx() {
    ctx.hidden = true;
  }
  rowsEl.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    e.preventDefault();
    const item = byId(tr.dataset.id);
    const rule = ruleFor(item.req, true);
    ctx.innerHTML = `
      <button data-c="override" class="primary-item">${rule ? 'Edit override' : 'Override API'}</button>
      ${
        rule
          ? `<button data-c="toggle">${rule.enabled ? 'Disable override' : 'Enable override'}</button>
                <button data-c="delete">Delete override</button>`
          : ''
      }
      <hr>
      <button data-c="copy-url">Copy URL</button>
      <button data-c="copy-resp">Copy response</button>`;
    ctx.hidden = false;
    const w = ctx.offsetWidth,
      h = ctx.offsetHeight;
    ctx.style.left = Math.min(e.clientX, innerWidth - w - 4) + 'px';
    ctx.style.top = Math.min(e.clientY, innerHeight - h - 4) + 'px';
    ctx.onclick = async (ev) => {
      const c = ev.target.dataset.c;
      if (!c) return;
      hideCtx();
      if (c === 'override') overrideFrom(item.req);
      if (c === 'toggle') APIOV.toggle(rule.id, !rule.enabled);
      if (
        c === 'delete' &&
        (await APIOV.confirmDialog(`Delete override for ${rule.method} ${rule.pattern}?`, {
          okText: 'Delete',
          danger: true
        }))
      )
        APIOV.remove(rule.id);
      if (c === 'copy-url') {
        await APIOV.copyText(item.req.request.url);
        APIOV.toast('URL copied');
      }
      if (c === 'copy-resp') {
        const { content } = await shownContent(item);
        await APIOV.copyText(APIOV.prettyJson(content) ?? content);
        APIOV.toast('Response copied');
      }
    };
  });
  document.addEventListener('click', (e) => {
    if (!ctx.contains(e.target)) hideCtx();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCtx();
  });
  window.addEventListener('blur', hideCtx);

  window.apiovConnect = ({ entries, applied = [], subscribe }) => {
    entries.forEach((req) => items.push({ id: nextId++, req }));
    applied.forEach((rec) => onApplied(rec, true));
    renderRows();
    const unsub = subscribe((msg) => {
      if (msg.type === 'add') add(msg.req);
      if (msg.type === 'applied') onApplied(msg.rec);
      if (msg.type === 'navigated' && !$('preserve').checked) {
        items = [];
        pending = [];
        closePreview();
        renderRows();
      }
    });
    window.addEventListener('pagehide', unsub);
  };
})();
