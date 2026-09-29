importScripts('lib/folder-sync.js');

async function updateBadge() {
  const d = await chrome.storage.local.get(['apiov_rules', 'apiov_enabled']);
  const on = d.apiov_enabled !== false;
  const n = (d.apiov_rules || []).filter((r) => r.enabled).length;
  await chrome.action.setBadgeText({ text: !on ? 'off' : n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: on ? '#FF6B5B' : '#6b7280' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: on ? '#0F1B24' : '#ffffff' });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.apiov_rules || c.apiov_enabled)) updateBadge();
});

async function openEditorWindow() {
  const url = chrome.runtime.getURL('editor.html') + '#draft=' + Date.now();
  const { editorWindowId } = await chrome.storage.session.get('editorWindowId');
  if (editorWindowId) {
    try {
      const win = await chrome.windows.get(editorWindowId, { populate: true });
      const tab = win.tabs && win.tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(win.id, { focused: true });
        return;
      }
    } catch (_) {}
  }
  const win = await chrome.windows.create({ url, type: 'popup', width: 920, height: 780, focused: true });
  await chrome.storage.session.set({ editorWindowId: win.id });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.type === 'apiov:open-editor') openEditorWindow();
  if (msg.type === 'apiov:devtools-loaded' && typeof msg.tabId === 'number') {
    chrome.storage.session.get('devtoolsTabs').then(({ devtoolsTabs = {} }) => {
      devtoolsTabs[msg.tabId] = Date.now();
      chrome.storage.session.set({ devtoolsTabs });
    });
  }
  if (msg.type === 'apiov:devtools-status') {
    chrome.storage.session
      .get('devtoolsTabs')
      .then(({ devtoolsTabs = {} }) => reply({ at: devtoolsTabs[msg.tabId] || 0 }));
    return true;
  }
});
chrome.windows.onRemoved.addListener(async (id) => {
  const { editorWindowId } = await chrome.storage.session.get('editorWindowId');
  if (id === editorWindowId) chrome.storage.session.remove('editorWindowId');
});

FolderSync.watch();
chrome.runtime.onStartup.addListener(() => FolderSync.sync().catch(() => {}));
