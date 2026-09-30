const view = mountRulesView(document.getElementById('rules'), {
  onEdit: (rule, isNew) => openRuleEditor({ rule, isNew })
});

async function handleHash() {
  const h = location.hash;
  if (h === '#new' || h.startsWith('#new=')) {
    const groupId = h.startsWith('#new=') ? decodeURIComponent(h.slice(5)) : null;
    openRuleEditor({ rule: APIOV.newRule({ groupId }), isNew: true });
  } else if (h.startsWith('#edit=')) {
    const id = h.slice(6);
    const { rules } = await APIOV.load();
    const rule = rules.find((r) => r.id === id);
    if (rule) openRuleEditor({ rule });
  }
  if (h === '#folder')
    setTimeout(() => document.getElementById('folder-box').scrollIntoView({ behavior: 'smooth' }), 100);
  if (h) history.replaceState(null, '', location.pathname);
}
handleHash();

(async () => {
  const el = document.getElementById('set-panel');
  const { apiov_settings: st = {} } = await chrome.storage.local.get('apiov_settings');
  el.checked = !!st.devtoolsPanel;
  el.addEventListener('change', async () => {
    const { apiov_settings: cur = {} } = await chrome.storage.local.get('apiov_settings');
    await chrome.storage.local.set({ apiov_settings: { ...cur, devtoolsPanel: el.checked } });
    APIOV.toast('Saved — reopen DevTools to apply');
  });
})();

(() => {
  const $ = (id) => document.getElementById(id);
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const plural = (n) => `${n} override${n === 1 ? '' : 's'}`;

  function show(status) {
    const title = $('folder-title'),
      sub = $('folder-sub'),
      banner = $('folder-banner');
    const has = status.state !== 'none';
    $('folder-choose').textContent = has ? 'Change folder…' : 'Choose folder…';
    $('folder-reconnect').hidden = status.state !== 'needs-permission';
    $('folder-sync').hidden = !has || status.state === 'needs-permission';
    $('folder-disconnect').hidden = !has;
    banner.hidden = true;
    sub.className = 'folder-sub';
    if (!has) {
      title.textContent = 'No folder selected';
      sub.textContent = 'Your overrides are only stored in this browser. If you remove the extension, they are lost.';
      return;
    }
    title.textContent = `Folder: ${status.name}`;
    if (status.state === 'ok') {
      sub.textContent = `✓ Saved to ${FolderSync.FILE}${status.lastSyncAt ? ' — last synced ' + when(status.lastSyncAt) : ''}`;
      sub.classList.add('ok');
    } else if (status.state === 'needs-permission') {
      sub.textContent =
        'Chrome needs your permission again to use this folder (it asks after a browser restart). Changes are kept in the browser until then.';
      sub.classList.add('warn');
      banner.hidden = false;
      banner.innerHTML = `<span>⚠ Folder <b></b> isn't connected — new changes aren't being saved to disk.</span><span class="spacer"></span><button class="btn primary sm" id="banner-allow">Allow access</button>`;
      banner.querySelector('b').textContent = status.name;
      $('banner-allow').onclick = reconnect;
    } else if (status.state === 'error') {
      sub.textContent = '✕ ' + status.message;
      sub.classList.add('bad');
    } else if (status.state === 'conflict') {
      sub.textContent = 'Both the folder and the browser changed since the last sync.';
      sub.classList.add('warn');
    }
  }

  async function askConflict(file, local, first) {
    const msg = first
      ? `This folder already has ${plural(file.rules.length)} (saved ${when(file.savedAt)}).\nThis browser has ${plural(local.rules.length)}.\n\nWhat do you want to do?`
      : `The file in the folder was changed outside the extension (${plural(file.rules.length)}), and you also changed overrides here (${plural(local.rules.length)}).\n\nWhich version do you want to keep?`;
    const choice = await APIOV.choiceDialog(
      msg,
      [
        { value: 'browser', label: first ? 'Replace folder with browser' : 'Keep browser version' },
        { value: 'merge', label: 'Merge both' },
        { value: 'folder', label: first ? 'Load from folder' : 'Use folder version', kind: 'primary' }
      ],
      { title: first ? 'Overrides found in this folder' : 'Sync conflict' }
    );
    if (!choice) return false;
    await FolderSync.resolve(choice);
    APIOV.toast(
      choice === 'folder' ? 'Loaded overrides from folder' : choice === 'merge' ? 'Merged and saved' : 'Saved to folder'
    );
    return true;
  }

  async function refresh() {
    const s = await FolderSync.sync();
    if (s.state === 'conflict') {
      show(s);
      await askConflict(s.file, s.local, false);
      return refresh();
    }
    show(s);
    return s;
  }

  async function reconnect() {
    const p = await FolderSync.reconnect();
    if (p !== 'granted') return APIOV.toast('Permission not granted');
    refresh();
  }

  $('folder-choose').addEventListener('click', async () => {
    try {
      const r = await FolderSync.choose();
      if (r.needsChoice) await askConflict(r.file, r.local, true);
      else if (r.loaded) APIOV.toast(`Loaded ${plural(r.loaded)} from folder`);
      else APIOV.toast('Folder connected — overrides saved');
    } catch (e) {
      if (e.name !== 'AbortError') APIOV.toast(e.message);
    }
    refresh();
  });
  $('folder-reconnect').addEventListener('click', reconnect);
  $('folder-sync').addEventListener('click', async () => {
    const s = await refresh();
    if (s && s.state === 'ok') APIOV.toast('Synced');
  });
  $('folder-disconnect').addEventListener('click', async () => {
    if (
      !(await APIOV.confirmDialog(
        'Stop saving overrides to this folder? Your overrides stay in the browser and the file stays in the folder.',
        { okText: 'Stop using folder' }
      ))
    )
      return;
    await FolderSync.disconnect();
    refresh();
  });

  FolderSync.watch(show);
  refresh();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
