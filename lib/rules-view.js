const ICONS = {
  chevron:
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 4.2c0-.7.6-1.2 1.2-1.2h3.1l1.5 1.6h5.9c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H2.7c-.6 0-1.2-.5-1.2-1.2z" fill="currentColor"/></svg>',
  grip: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></g></svg>'
};

function mountRulesView(root, { compact = false, onEdit } = {}) {
  const { esc, statusClass } = APIOV;
  const T = APIOV_TREE;
  const edit = onEdit || ((rule) => openRuleEditor({ rule }));
  const COLLAPSED = 'apiov_collapsed';

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
      <button class="btn" data-act="export">Export…</button>`
      }
      <button class="btn" data-act="new-group" title="New group">+ Group</button>
      <button class="btn primary" data-act="new">+ New override</button>
      <input type="file" accept="application/json,.json" hidden>
    </div>
    <p class="order-hint">When several overrides match the same request, the one higher in the list wins. Drag overrides and groups to reorder or move them.</p>
    <ul class="rules"></ul>`;

  const list = root.querySelector('.rules');
  const globalEl = root.querySelector('[data-global]');
  const globalText = root.querySelector('[data-global-text]');
  const search = root.querySelector('.search');
  const fileInput = root.querySelector('input[type=file]');
  let current = { rules: [], groups: [], enabled: true };
  let collapsed = new Set();
  let renaming = null;

  const ruleText = (r) => (r.pattern + ' ' + (r.name || '') + ' ' + r.method).toLowerCase();
  const groupById = (id) => current.groups.find((x) => x.id === id);
  const parentOf = (gid) => {
    const chain = T.ancestors(current.groups, gid);
    return chain.length > 1 ? chain[chain.length - 2].id : null;
  };

  function visibility(q) {
    if (!q) return null;
    const { rules, groups } = current;
    const vr = new Set();
    const vg = new Set();
    const open = new Set();
    for (const x of groups)
      if (x.name.toLowerCase().includes(q)) {
        T.descendantIds(groups, x.id).forEach((id) => open.add(id));
        T.ancestors(groups, x.id).forEach((a) => vg.add(a.id));
      }
    open.forEach((id) => vg.add(id));
    for (const r of rules) {
      const gid = T.groupOf(groups, r);
      if (open.has(gid) || ruleText(r).includes(q)) {
        vr.add(r.id);
        T.ancestors(groups, gid).forEach((a) => vg.add(a.id));
      }
    }
    return { vr, vg };
  }

  function ruleHtml(r, i, n) {
    const u = splitPattern(r);
    const hasBody = !!(r.body && r.body.trim());
    const paused = r.enabled && !T.isOn(current.groups, T.groupOf(current.groups, r));
    return `
      <li class="rule ${r.enabled ? '' : 'disabled'} ${paused ? 'paused' : ''}" data-id="${r.id}" draggable="true">
        <div class="rc-top">
          <span class="grip" title="Drag to move">${ICONS.grip}</span>
          <label class="switch" title="${r.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}"><input type="checkbox" data-act="toggle" ${r.enabled ? 'checked' : ''}><i></i></label>
          <span class="method m-${esc(r.method)}">${esc(r.method)}</span>
          <span class="rc-name ${r.name ? '' : 'muted'}" title="${esc(r.name || 'Untitled override')}">${esc(r.name || 'Untitled override')}</span>
          <span class="rc-tags">
            ${paused ? '<span class="tag tag-paused" title="This override is on, but a group it is in is turned off">paused by group</span>' : ''}
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
          <button class="abtn a-move" data-act="move-to">Move to…</button>
          <button class="abtn a-move" data-act="top" ${i === 0 ? 'disabled' : ''} title="Move to the top of ${r.groupId ? 'its group' : 'the list'}">Move to top</button>
          ${
            compact
              ? ''
              : `
          <button class="abtn a-move" data-act="up" ${i === 0 ? 'disabled' : ''}>Move up</button>
          <button class="abtn a-move" data-act="down" ${i === n - 1 ? 'disabled' : ''}>Move down</button>`
          }
          <span class="spacer"></span>
          <button class="abtn a-delete" data-act="delete">Delete</button>
        </div>
      </li>`;
  }

  function groupHtml(x, vis) {
    const { rules, groups } = current;
    const c = T.counts(rules, groups, x.id);
    const parentOn = T.isOn(groups, parentOf(x.id));
    const isCollapsed = !vis && collapsed.has(x.id);
    const inner = levelHtml(x.id, vis);
    return `
      <li class="group ${isCollapsed ? 'collapsed' : ''} ${x.enabled ? '' : 'disabled'} ${x.enabled && !parentOn ? 'paused' : ''}" data-gid="${x.id}">
        <div class="group-head" draggable="true">
          <button class="chev" data-act="collapse" aria-expanded="${!isCollapsed}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${ICONS.chevron}</button>
          <label class="switch" title="${x.enabled ? 'Group on — click to pause everything in it' : 'Group off — click to turn it back on'}"><input type="checkbox" data-act="gtoggle" ${x.enabled ? 'checked' : ''}><i></i></label>
          <span class="g-icon">${ICONS.folder}</span>
          <span class="g-name" title="${esc(x.name)} — double-click to rename">${esc(x.name || 'Untitled group')}</span>
          <span class="g-count" title="${c.active} of ${c.total} override${c.total === 1 ? '' : 's'} active">${c.active}/${c.total}</span>
          ${x.enabled && !parentOn ? '<span class="tag tag-paused">paused by parent</span>' : ''}
          <span class="spacer"></span>
          <button class="abtn a-ghost" data-act="gnew" title="New override in this group">+ Override</button>
          <button class="icon-btn g-more" data-act="gmenu" title="Group actions" aria-haspopup="menu">⋯</button>
        </div>
        <ul class="group-body">${inner || `<li class="g-empty">${vis ? 'No matches' : 'Empty group — drag overrides here or click <b>+ Override</b>'}</li>`}</ul>
      </li>`;
  }

  function levelHtml(pid, vis) {
    const { rules, groups } = current;
    const all = T.children(rules, groups, pid);
    return all
      .map((c, i) => {
        if (c.type === 'g') return !vis || vis.vg.has(c.item.id) ? groupHtml(c.item, vis) : '';
        return !vis || vis.vr.has(c.item.id) ? ruleHtml(c.item, i, all.length) : '';
      })
      .join('');
  }

  function render() {
    if (renaming) return;
    const { rules, groups, enabled } = current;
    globalEl.checked = enabled;
    globalText.textContent = enabled ? 'on' : 'off';
    root.classList.toggle('globally-off', !enabled);
    const q = search.value.trim().toLowerCase();
    if (!rules.length && !groups.length) {
      list.innerHTML = `<li class="empty">
        <b>No overrides yet.</b><br>
        Open DevTools → <b>Network</b>, right-click a request and choose <b>Open using Doppel</b>,
        or click <b>+ New override</b>.</li>`;
      return;
    }
    const html = levelHtml(null, visibility(q));
    if (!html) {
      list.innerHTML = '<li class="empty">No overrides match the filter.</li>';
      return;
    }
    list.innerHTML =
      html +
      (groups.length
        ? '<li class="drop-root" data-drop-root>Drop here to move to the bottom of the list (top level)</li>'
        : '');
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

  async function saveCollapsed() {
    await chrome.storage.local.set({ [COLLAPSED]: [...collapsed] });
  }
  function expand(gid) {
    let changed = false;
    for (const a of T.ancestors(current.groups, gid)) if (collapsed.delete(a.id)) changed = true;
    if (changed) saveCollapsed();
  }

  async function refresh() {
    const [state, ui] = await Promise.all([APIOV.load(), chrome.storage.local.get(COLLAPSED)]);
    current = state;
    collapsed = new Set(ui[COLLAPSED] || []);
    render();
  }
  APIOV.onChange((d) => {
    current = d;
    render();
  });
  search.addEventListener('input', render);
  globalEl.addEventListener('change', () => APIOV.setEnabled(globalEl.checked));

  function startRename(gid) {
    const x = groupById(gid);
    const head = list.querySelector(`.group[data-gid="${gid}"] > .group-head`);
    if (!x || !head) return;
    const nameEl = head.querySelector('.g-name');
    const input = document.createElement('input');
    input.className = 'g-rename';
    input.value = x.name;
    input.setAttribute('aria-label', 'Group name');
    head.draggable = false;
    nameEl.replaceWith(input);
    renaming = gid;
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      renaming = null;
      const v = input.value.trim();
      if (save && v && v !== x.name) {
        await APIOV.updateGroup(gid, { name: v });
        current = await APIOV.load();
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function createGroup(parentId = null) {
    const x = APIOV.newGroup({ parentId });
    await APIOV.addGroup(x);
    if (search.value) search.value = '';
    if (parentId) expand(parentId);
    current = await APIOV.load();
    render();
    startRename(x.id);
  }

  function destinations({ exclude, currentId }) {
    return [
      { label: 'Top level (no group)', icon: '⌂', current: !currentId, disabled: !currentId, value: null },
      ...T.flatGroups(current.groups)
        .filter(({ group }) => !exclude || !exclude.has(group.id))
        .map(({ group, depth }) => ({
          label: group.name || 'Untitled group',
          icon: ICONS.folder,
          depth: depth + 1,
          current: group.id === currentId,
          disabled: group.id === currentId,
          value: group.id
        }))
    ];
  }

  function moveRuleMenu(anchor, rule) {
    const gid = T.groupOf(current.groups, rule);
    if (!current.groups.length)
      return APIOV.menu(anchor, [
        { heading: 'No groups yet' },
        { label: '+ Create a group and move here', run: () => createGroupWith(rule.id) }
      ]);
    APIOV.menu(anchor, [
      { heading: 'Move override to' },
      ...destinations({ currentId: gid }).map((d) => ({
        ...d,
        run: () => moveItem({ type: 'r', id: rule.id }, d.value)
      })),
      '-',
      { label: '+ New group…', run: () => createGroupWith(rule.id) }
    ]);
  }

  async function createGroupWith(ruleId) {
    const x = APIOV.newGroup();
    await APIOV.mutate(({ rules, groups }) => {
      const withGroup = T.placeItem(rules, [...groups, x], { type: 'g', id: x.id }, { parentId: null, index: 0 });
      return T.placeItem(withGroup.rules, withGroup.groups, { type: 'r', id: ruleId }, { parentId: x.id, index: 0 });
    });
    current = await APIOV.load();
    render();
    startRename(x.id);
  }

  async function moveItem(ref, parentId, index = 0) {
    const res = await APIOV.place(ref, { parentId, index });
    if (!res) return APIOV.toast("A group can't be moved into itself");
    if (parentId && collapsed.has(parentId)) {
      const x = groupById(parentId);
      APIOV.toast(`Moved to “${x ? x.name : 'group'}”`);
    }
  }

  function groupMenu(anchor, x) {
    const ref = { type: 'g', id: x.id };
    const i = T.indexIn(current.rules, current.groups, ref);
    const n = T.children(current.rules, current.groups, parentOf(x.id)).length;
    const items = [
      { label: 'New override here', run: () => edit(APIOV.newRule({ groupId: x.id }), true) },
      { label: 'New sub-group', run: () => createGroup(x.id) },
      { label: 'Rename', run: () => startRename(x.id) },
      '-',
      { label: 'Move to top', disabled: i <= 0, run: () => APIOV.toTop(ref) },
      { label: 'Move up', disabled: i <= 0, run: () => APIOV.shift(ref, -1) },
      { label: 'Move down', disabled: i === n - 1, run: () => APIOV.shift(ref, 1) },
      { label: 'Move to…', run: () => moveGroupMenu(anchor, x) }
    ];
    if (!compact)
      items.push('-', {
        label: 'Export this group',
        run: () => {
          const data = T.exportGroup(current.rules, current.groups, x.id);
          APIOV.download(`doppel-${APIOV.slug(x.name)}.json`, data);
          APIOV.toast(`Exported ${data.rules.length} override(s)`);
        }
      });
    items.push('-', { label: 'Delete group…', danger: true, run: () => deleteGroup(x) });
    APIOV.menu(anchor, items);
  }

  function moveGroupMenu(anchor, x) {
    const exclude = T.descendantIds(current.groups, x.id);
    APIOV.menu(anchor, [
      { heading: `Move “${x.name}” to` },
      ...destinations({ exclude, currentId: parentOf(x.id) }).map((d) => ({
        ...d,
        run: () => {
          if (d.value) expand(d.value);
          moveItem({ type: 'g', id: x.id }, d.value);
        }
      }))
    ]);
  }

  async function deleteGroup(x) {
    const c = T.counts(current.rules, current.groups, x.id);
    if (!c.total && !c.groups) {
      if (await APIOV.confirmDialog(`Delete group “${x.name}”?`, { okText: 'Delete', danger: true }))
        await APIOV.mutate(({ rules, groups }) => T.removeGroup(rules, groups, x.id, false));
      return;
    }
    const what = [
      c.total ? `${c.total} override${c.total === 1 ? '' : 's'}` : '',
      c.groups ? `${c.groups} sub-group${c.groups === 1 ? '' : 's'}` : ''
    ]
      .filter(Boolean)
      .join(' and ');
    const choice = await APIOV.choiceDialog(
      `“${x.name}” contains ${what}.\n\nKeep them (they move up one level), or delete everything inside too?`,
      [
        { value: null, label: 'Cancel' },
        { value: 'keep', label: 'Delete group, keep contents' },
        { value: 'all', label: 'Delete everything', kind: 'danger' }
      ],
      { title: 'Delete group' }
    );
    if (!choice) return;
    await APIOV.mutate(({ rules, groups }) => T.removeGroup(rules, groups, x.id, choice === 'keep'));
    APIOV.toast(choice === 'keep' ? 'Group deleted, contents kept' : 'Group and its contents deleted');
  }

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.dataset.act === 'toggle' || el.dataset.act === 'gtoggle') return;
    const act = el.dataset.act;
    const id = el.closest('[data-id]')?.dataset.id;
    const gid = el.closest('[data-gid]')?.dataset.gid;
    const rule = current.rules.find((r) => r.id === id);
    const group = groupById(gid);
    if (act === 'new') return edit(APIOV.newRule(), true);
    if (act === 'new-group') return createGroup(null);
    if (act === 'edit' && rule) return edit(rule, false);
    if (act === 'collapse' && group) {
      if (collapsed.has(gid)) collapsed.delete(gid);
      else collapsed.add(gid);
      saveCollapsed();
      return render();
    }
    if (act === 'gnew' && group) return edit(APIOV.newRule({ groupId: gid }), true);
    if (act === 'gmenu' && group) return groupMenu(el, group);
    if (act === 'move-to' && rule) return moveRuleMenu(el, rule);
    if (act === 'delete' && rule) {
      if (
        await APIOV.confirmDialog(`Delete override for ${rule.method} ${rule.pattern}?`, {
          okText: 'Delete',
          danger: true
        })
      )
        await APIOV.remove(id);
    }
    if (act === 'dup' && rule) {
      const name = await APIOV.promptDialog('Duplicate override', {
        label: 'New name',
        value: rule.name || '',
        subtitle: `Copy of ${rule.method} ${rule.pattern}`,
        placeholder: 'Untitled override',
        okText: 'Duplicate'
      });
      if (name !== null) await APIOV.duplicate(id, name);
    }
    if (act === 'top') await APIOV.toTop({ type: 'r', id });
    if (act === 'up') await APIOV.move(id, -1);
    if (act === 'down') await APIOV.move(id, 1);
    if (act === 'export') openExportDialog(current);
    if (act === 'import') fileInput.click();
  });

  list.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.g-name');
    if (name) startRename(name.closest('[data-gid]').dataset.gid);
  });

  root.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'toggle') {
      APIOV.toggle(e.target.closest('[data-id]').dataset.id, e.target.checked);
    }
    if (e.target.dataset.act === 'gtoggle') {
      APIOV.updateGroup(e.target.closest('[data-gid]').dataset.gid, { enabled: e.target.checked });
    }
  });

  let drag = null;
  let target = null;
  let hoverTimer = null;
  let hoverGid = null;
  const slot = document.createElement('li');
  slot.className = 'drop-slot';

  const refOf = (li) =>
    li.classList.contains('group') ? { type: 'g', id: li.dataset.gid } : { type: 'r', id: li.dataset.id };
  const sameRef = (a, b) => a.type === b.type && a.id === b.id;
  const groupName = (gid) => {
    const x = groupById(gid);
    return x ? `“${x.name || 'Untitled group'}”` : 'group';
  };

  function blocked(parentId) {
    return drag.type === 'g' && parentId && T.descendantIds(current.groups, drag.id).has(parentId);
  }

  function positionFor(ref, after) {
    const { rules, groups } = current;
    const parentId = T.containerOf(rules, groups, ref);
    let index = T.indexIn(rules, groups, ref) + (after ? 1 : 0);
    const from = T.containerOf(rules, groups, drag) === parentId ? T.indexIn(rules, groups, drag) : -1;
    if (from >= 0 && from < index) index--;
    return { parentId, index, noop: from === index };
  }

  function computeTarget(e) {
    const el = e.target instanceof Element ? e.target : e.target.parentElement;
    if (!el) return null;
    if (el.closest('.drop-slot')) return target;
    const zone = el.closest('[data-drop-root]');
    if (zone) return { parentId: null, index: Infinity, highlight: zone };
    const empty = el.closest('.g-empty');
    if (empty) {
      const gid = empty.closest('[data-gid]').dataset.gid;
      if (blocked(gid)) return null;
      return { parentId: gid, index: 0, slotIn: empty.parentElement };
    }
    const head = el.closest('.group-head');
    const li = head ? head.parentElement : el.closest('.rule');
    if (!li || !list.contains(li)) return null;
    const ref = refOf(li);
    if (sameRef(ref, drag)) return null;
    if (blocked(T.containerOf(current.rules, current.groups, ref)) || (ref.type === 'g' && blocked(ref.id)))
      return null;
    const box = (head || li).getBoundingClientRect();
    const y = (e.clientY - box.top) / box.height;
    if (head) {
      const isCollapsed = li.classList.contains('collapsed');
      if (y < 0.3) return { ...positionFor(ref, false), slotBefore: li };
      if (isCollapsed && y > 0.7) return { ...positionFor(ref, true), slotAfter: li };
      if (isCollapsed) return { parentId: ref.id, index: 0, highlight: head, into: true };
      return { parentId: ref.id, index: 0, slotIn: li.querySelector(':scope > .group-body') };
    }
    return y < 0.5 ? { ...positionFor(ref, false), slotBefore: li } : { ...positionFor(ref, true), slotAfter: li };
  }

  function slotLabel(t) {
    if (t.noop) return '<span class="ds-arrow">↺</span> Current position';
    const where = t.parentId ? `in ${groupName(t.parentId)}` : 'at the top level';
    const pos = t.index === 0 ? (t.parentId ? `Top of ${groupName(t.parentId)}` : 'Top of the list') : `Here, ${where}`;
    return `<span class="ds-arrow">➜</span> ${esc(pos)}`;
  }

  const keyOf = (t) => (t.highlight ? 'hl:' : 'at:') + t.parentId + ':' + t.index;

  function show(t) {
    if (!t || (target && keyOf(target) === keyOf(t))) return;
    if (target && target.highlight) target.highlight.classList.remove('drop-into');
    target = t;
    if (t.highlight) {
      t.highlight.classList.add('drop-into');
      slot.classList.add('ghost');
      return;
    }
    slot.classList.remove('ghost');
    slot.innerHTML = slotLabel(target);
    if (target.slotBefore) target.slotBefore.before(slot);
    else if (target.slotAfter) target.slotAfter.after(slot);
    else target.slotIn.prepend(slot);
  }

  function endDrag() {
    if (target && target.highlight) target.highlight.classList.remove('drop-into');
    target = null;
    slot.remove();
    clearTimeout(hoverTimer);
    hoverGid = null;
    root.classList.remove('is-dragging');
    list.querySelectorAll('.dragging').forEach((x) => x.classList.remove('dragging'));
    drag = null;
  }

  list.addEventListener('dragstart', (e) => {
    if (renaming) return e.preventDefault();
    const head = e.target.closest?.('.group-head');
    const card = !head && e.target.closest?.('.rule');
    if (head) drag = { type: 'g', id: head.parentElement.dataset.gid };
    else if (card) drag = { type: 'r', id: card.dataset.id };
    else return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    const node = head ? head.parentElement : card;
    const { rules, groups } = current;
    const start = { parentId: T.containerOf(rules, groups, drag), index: T.indexIn(rules, groups, drag), noop: true };
    requestAnimationFrame(() => {
      if (!drag) return;
      root.classList.add('is-dragging');
      node.classList.add('dragging');
      if (!target) show({ ...start, slotAfter: node });
    });
  });
  list.addEventListener('dragover', (e) => {
    if (!drag) return;
    show(computeTarget(e));
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const gid = target && target.into ? target.parentId : null;
    if (gid !== hoverGid) {
      clearTimeout(hoverTimer);
      hoverGid = gid;
      if (gid)
        hoverTimer = setTimeout(() => {
          collapsed.delete(gid);
          saveCollapsed();
          const li = list.querySelector(`.group[data-gid="${gid}"]`);
          if (li) li.classList.remove('collapsed');
        }, 600);
    }
  });
  list.addEventListener('drop', async (e) => {
    if (!drag) return;
    e.preventDefault();
    const d = drag;
    const t = target;
    endDrag();
    if (!t || t.noop) return;
    if (t.parentId) expand(t.parentId);
    await moveItem(d, t.parentId, t.index);
  });
  list.addEventListener('dragend', endDrag);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const incoming = T.parseImport(JSON.parse(await file.text()));
      if (!incoming.rules.length && !incoming.groups.length) throw new Error('No overrides found in file');
      let result;
      await APIOV.mutate(({ rules, groups }) => {
        result = T.importData(rules, groups, incoming);
        const fresh = new Set(result.rules.slice(0, result.added).map((r) => r.id));
        result.rules = result.rules.map((r) => (fresh.has(r.id) ? APIOV.newRule(r) : r));
        return result;
      });
      const g = incoming.groups.length;
      APIOV.toast(`Imported ${result.added} override(s)${g ? ` in ${g} group(s)` : ''}`);
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

function openExportDialog({ rules, groups }) {
  const { esc } = APIOV;
  const T = APIOV_TREE;
  const rows = [];
  const walk = (pid, depth, anc) => {
    for (const { type, item } of T.children(rules, groups, pid)) {
      if (type === 'r') {
        rows.push({ kind: 'r', id: item.id, depth, anc, parent: pid, rule: item });
        continue;
      }
      const c = T.counts(rules, groups, item.id);
      rows.push({
        kind: 'g',
        id: item.id,
        depth,
        anc,
        parent: pid,
        label: item.name || 'Untitled group',
        count: c.total
      });
      walk(item.id, depth + 1, [...anc, item.id]);
    }
  };
  walk(null, 0, []);

  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
  <div class="modal export-modal" role="dialog" aria-modal="true" aria-label="Export overrides">
    <header><h2>Export overrides</h2><button class="icon-btn" data-x="close" title="Close (Esc)">✕</button></header>
    <div class="modal-body">
      <p class="hint">Pick the groups and overrides to export. Checking a group includes everything inside it.</p>
      <div class="export-bar">
        <label class="check"><input type="checkbox" data-all> <b>Select all</b></label>
        <span class="spacer"></span>
        <span class="muted" data-sum></span>
      </div>
      <ul class="export-tree">${rows
        .map((row) =>
          row.kind === 'g'
            ? `<li class="ex-g" style="--d:${row.depth}"><label class="check"><input type="checkbox" data-kind="g" data-id="${row.id}" data-parent="${row.parent || ''}" data-anc="${row.anc.join(' ')}">
               <span class="g-icon">${ICONS.folder}</span><b>${esc(row.label)}</b> <span class="muted">(${row.count})</span></label></li>`
            : `<li class="ex-r" style="--d:${row.depth}"><label class="check"><input type="checkbox" data-kind="r" data-id="${row.id}" data-parent="${row.parent || ''}" data-anc="${row.anc.join(' ')}">
               <span class="method m-${esc(row.rule.method)}">${esc(row.rule.method)}</span><span class="ex-name">${esc(row.rule.name || row.rule.pattern)}</span></label></li>`
        )
        .join('')}</ul>
    </div>
    <footer><div class="spacer"></div>
      <button class="btn" data-x="close">Cancel</button>
      <button class="btn primary" data-x="export">Export</button></footer>
  </div>`;
  document.body.appendChild(back);

  const boxes = [...back.querySelectorAll('.export-tree input')];
  const groupBoxes = boxes.filter((b) => b.dataset.kind === 'g').reverse();
  const all = back.querySelector('[data-all]');
  const sum = back.querySelector('[data-sum]');
  const exportBtn = back.querySelector('[data-x="export"]');

  function sync() {
    for (const g of groupBoxes) {
      const kids = boxes.filter((b) => b.dataset.parent === g.dataset.id);
      if (!kids.length) continue;
      const on = kids.filter((b) => b.checked).length;
      const partial = kids.some((b) => b.indeterminate);
      g.checked = on === kids.length && !partial;
      g.indeterminate = !g.checked && (on > 0 || partial);
    }
    const n = boxes.filter((b) => b.dataset.kind === 'r' && b.checked).length;
    const total = rules.length;
    all.checked = boxes.every((b) => b.checked);
    all.indeterminate = !all.checked && boxes.some((b) => b.checked || b.indeterminate);
    sum.textContent = `${n} of ${total} override${total === 1 ? '' : 's'} selected`;
    exportBtn.disabled = !boxes.some((b) => b.checked);
  }

  boxes.forEach((b) => (b.checked = true));
  sync();

  back.addEventListener('change', (e) => {
    const b = e.target;
    if (b === all) boxes.forEach((x) => (x.checked = all.checked));
    else if (b.dataset.kind === 'g')
      back.querySelectorAll(`.export-tree input[data-anc~="${b.dataset.id}"]`).forEach((x) => {
        x.checked = b.checked;
        x.indeterminate = false;
      });
    sync();
  });

  function doExport() {
    const ruleIds = boxes.filter((b) => b.dataset.kind === 'r' && b.checked).map((b) => b.dataset.id);
    const picked = groupBoxes.filter((b) => b.checked || b.indeterminate);
    const groupIds = picked.map((b) => b.dataset.id);
    const data = T.exportData(rules, groups, { ruleIds, groupIds });
    const tops = groupBoxes.filter((b) => b.checked && !groupIds.includes(b.dataset.parent));
    const single =
      tops.length === 1 &&
      !data.rules.some((r) => !T.descendantIds(groups, tops[0].dataset.id).has(T.groupOf(groups, r))) &&
      groupIds.every((id) => T.descendantIds(groups, tops[0].dataset.id).has(id));
    const name = single ? groups.find((x) => x.id === tops[0].dataset.id).name : '';
    APIOV.download(single ? `doppel-${APIOV.slug(name)}.json` : 'doppel-export.json', data);
    APIOV.toast(`Exported ${data.rules.length} override(s)`);
    close();
  }

  const onKey = (e) => {
    if (document.querySelector('.confirm-back')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function close() {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('click', (e) => {
    if (e.target === back) return close();
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'close') close();
    if (x === 'export') doExport();
  });
  exportBtn.focus();
}
