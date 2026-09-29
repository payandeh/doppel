let __apiovEditorOpen = null;

function openRuleEditor({
  rule,
  isNew = false,
  originalStatus = null,
  onSaved,
  standalone = false,
  note = '',
  onClose
} = {}) {
  if (__apiovEditorOpen) __apiovEditorOpen();
  const { esc, METHODS, MATCH_TYPES } = APIOV;
  rule = { ...APIOV.newRule(), ...rule };

  let initialBody = rule.body || '';
  if (initialBody && !initialBody.includes('\n')) {
    const f = JsonCheck.format(initialBody);
    if (f.ok) initialBody = f.text;
  }

  const back = document.createElement('div');
  back.className = 'modal-back' + (standalone ? ' standalone' : '');
  back.innerHTML = `
  <div class="modal" role="dialog" aria-modal="true">
    <header>
      <h2>${isNew ? 'Override API' : 'Edit override'}</h2>
      <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
    </header>
    <div class="modal-body">
      ${note ? `<p class="draft-note">${esc(note)}</p>` : ''}
      <label class="field"><span>Name <em>optional</em></span>
        <input name="name" placeholder="e.g. Login fails with 401" value="${esc(rule.name)}"></label>
      <div class="row">
        <label class="field w-method"><span>Method</span>
          <select name="method">${METHODS.map((m) => `<option ${m === rule.method ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="field w-match"><span>URL match</span>
          <select name="matchType">${MATCH_TYPES.map(([v, l]) => `<option value="${v}" ${v === rule.matchType ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field grow"><span>URL</span>
          <input name="pattern" class="mono" spellcheck="false" placeholder="https://api.example.com/v1/users" value="${esc(rule.pattern)}"></label>
      </div>
      <div class="row tight">
        <label class="check" data-only="equals"><input type="checkbox" name="ignoreQuery" ${rule.ignoreQuery ? 'checked' : ''}> Ignore query string</label>
        <span class="hint" data-only="wildcard">Use * for any characters, e.g. <code>*/api/users/*</code></span>
        <span class="hint" data-only="regex">JavaScript regex tested against the full URL</span>
      </div>
      <div class="row">
        <label class="field w-status"><span>Status code</span>
          <input name="status" type="number" min="200" max="599" list="apiov-statuses"
            placeholder="${originalStatus ? 'Original (' + originalStatus + ')' : 'Original'}" value="${rule.status ?? ''}"></label>
        <label class="field w-delay"><span>Delay (ms)</span>
          <input name="delay" type="number" min="0" step="100" placeholder="0" value="${rule.delay || ''}"></label>
        <label class="check self-end"><input type="checkbox" name="mockOnly" ${rule.mockOnly ? 'checked' : ''}> Mock only (don't call the server)</label>
      </div>
      <p class="hint">Empty status → the real status is kept. Empty body → the real body is kept.</p>
      <div class="body-head">
        <span class="label">Response body (JSON)</span>
        <button class="json-state" type="button" data-act="goto-error"></button>
        <div class="spacer"></div>
        <button class="btn sm" data-act="format" title="Beautify (Shift+Alt+F)">Beautify</button>
        <button class="btn sm" data-act="minify">Minify</button>
        <button class="btn sm" data-act="clear" title="Empty = keep the original body">Clear</button>
      </div>
      <div class="json-host"></div>
      <p class="error" hidden></p>
    </div>
    <footer>
      <label class="check"><input type="checkbox" name="enabled" ${rule.enabled ? 'checked' : ''}> Enabled</label>
      <div class="spacer"></div>
      <button class="btn" data-act="close">Cancel</button>
      <button class="btn primary" data-act="save">Save <kbd>⌘/Ctrl S</kbd></button>
    </footer>
  </div>
  <datalist id="apiov-statuses">
    ${[200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504].map((s) => `<option value="${s}">`).join('')}
  </datalist>`;
  document.body.appendChild(back);

  const $ = (sel) => back.querySelector(sel);
  const f = (name) => back.querySelector(`[name="${name}"]`);
  const errEl = $('.error');
  const jsonState = $('.json-state');
  let lastError = null;

  const lint = (text) => {
    const r = JsonCheck.validate(text);
    if (r.ok || r.empty) return [];
    const to = Math.min(r.pos + 1, text.length);
    return [{ from: Math.min(r.pos, to), to, severity: 'error', message: r.message }];
  };
  const editor = JsonEditor.create({
    parent: $('.json-host'),
    doc: initialBody,
    lint,
    onChange: syncJsonState
  });
  function getBody() {
    return editor.getValue();
  }

  function syncJsonState() {
    const text = getBody();
    const r = JsonCheck.validate(text);
    lastError = null;
    if (r.empty) {
      jsonState.textContent = 'empty — original body will be used';
      jsonState.className = 'json-state muted';
      return;
    }
    if (r.ok) {
      jsonState.textContent = '✓ valid JSON';
      jsonState.className = 'json-state ok';
      return;
    }
    lastError = r;
    jsonState.textContent = '✕ ' + JsonCheck.describe(r);
    jsonState.title = 'Click to jump to the error';
    jsonState.className = 'json-state bad';
  }
  syncJsonState();

  function syncMatchType() {
    const t = f('matchType').value;
    back.querySelectorAll('[data-only]').forEach((el) => {
      el.hidden = el.dataset.only !== t;
    });
  }
  syncMatchType();
  f('matchType').addEventListener('change', syncMatchType);

  function close() {
    editor.destroy();
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    __apiovEditorOpen = null;
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (onClose) onClose();
  }
  __apiovEditorOpen = close;
  const snapshot = () =>
    JSON.stringify([...back.querySelectorAll('[name]')].map((el) => (el.type === 'checkbox' ? el.checked : el.value))) +
    getBody();
  const initialSnapshot = snapshot();
  const onBeforeUnload = (e) => {
    if (snapshot() !== initialSnapshot) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  if (standalone) window.addEventListener('beforeunload', onBeforeUnload);
  async function requestClose() {
    if (
      snapshot() !== initialSnapshot &&
      !(await APIOV.confirmDialog('Discard your unsaved changes?', { okText: 'Discard', danger: true }))
    )
      return;
    close();
  }
  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function transform(kind) {
    const r = kind === 'format' ? JsonCheck.format(getBody()) : JsonCheck.minify(getBody());
    if (r.empty) return;
    if (!r.ok) {
      showError(`Can't ${kind === 'format' ? 'beautify' : 'minify'} — ${JsonCheck.describe(r)}`);
      editor.goTo(r.pos);
      return;
    }
    showError('');
    editor.setValue(r.text);
  }

  async function save() {
    const pattern = f('pattern').value.trim();
    const statusRaw = f('status').value.trim();
    const body = getBody();
    const matchType = f('matchType').value;
    if (!pattern) {
      f('pattern').focus();
      return showError('URL is required.');
    }
    if (matchType === 'regex') {
      try {
        new RegExp(pattern);
      } catch (e) {
        return showError('Invalid regex: ' + e.message);
      }
    }
    let status = null;
    if (statusRaw) {
      status = Number(statusRaw);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        f('status').focus();
        return showError('Status must be a whole number between 200 and 599 (or empty to keep the original).');
      }
    }
    const v = JsonCheck.validate(body);
    if (!v.ok && !v.empty) {
      editor.goTo(v.pos);
      return showError('Response body is not valid JSON — ' + JsonCheck.describe(v));
    }
    const mockOnly = f('mockOnly').checked;
    if (mockOnly && v.empty) return showError('"Mock only" needs a response body, since the server won\'t be called.');
    const updated = {
      ...rule,
      name: f('name').value.trim(),
      method: f('method').value,
      matchType,
      pattern,
      ignoreQuery: f('ignoreQuery').checked,
      status,
      delay: Math.max(0, parseInt(f('delay').value, 10) || 0),
      mockOnly,
      body: v.empty ? '' : body,
      enabled: f('enabled').checked
    };
    await APIOV.upsert(updated);
    close();
    APIOV.toast('Override saved');
    onSaved && onSaved(updated);
  }

  function onKey(e) {
    if (document.querySelector('.confirm-back')) return;
    if (e.key === 'Escape') {
      // Let CodeMirror close its own search panel or tooltip first.
      if (back.querySelector('.cm-panel.cm-search, .cm-tooltip-autocomplete')) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
    if (e.shiftKey && e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      transform('format');
    }
  }
  document.addEventListener('keydown', onKey, true);

  back.addEventListener('click', (e) => {
    if (e.target === back) return standalone ? undefined : requestClose();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') requestClose();
    if (act === 'save') save();
    if (act === 'format' || act === 'minify') transform(act);
    if (act === 'clear') {
      editor.setValue('');
      editor.focus();
    }
    if (act === 'goto-error' && lastError) editor.goTo(lastError.pos);
  });

  (isNew ? f('status') : f('pattern')).focus();
}
