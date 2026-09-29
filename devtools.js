// Always loaded while DevTools is open.
// 1) Buffers network requests (so we know method/status/body for a URL).
// 2) Registers an "open resource handler" — Chrome then shows
//    "Open using Doppel" when you right-click a request in the Network tab.
// 3) Optionally adds the "Doppel" DevTools tab (off by default).
const MAX = 1500;
const entries = [];
const subs = new Set();
const emit = (msg) => subs.forEach((fn) => { try { fn(msg); } catch (_) { subs.delete(fn); } });

chrome.devtools.network.onRequestFinished.addListener((req) => {
  entries.push(req);
  if (entries.length > MAX) entries.shift();
  emit({ type: 'add', req });
});
chrome.devtools.network.onNavigated.addListener((url) => emit({ type: 'navigated', url }));

// ---------- Network tab context menu: "Open using Doppel" ----------
function getContent(req) {
  return new Promise((resolve) => {
    try {
      req.getContent((content, encoding) => {
        if (content && encoding === 'base64') {
          try { content = new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0))); } catch (_) {}
        }
        resolve(content || '');
      });
    } catch (_) { resolve(''); }
  });
}

function findEntry(url) {
  const noHash = (u) => String(u).split('#')[0];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].request.url === url || noHash(entries[i].request.url) === noHash(url)) return entries[i];
  }
  return null;
}

async function openEditorFor(url) {
  const req = findEntry(url);
  const draft = { url, method: 'GET', status: null, body: '', found: false, at: Date.now() };
  if (req) {
    draft.found = true;
    draft.method = req.request.method.toUpperCase();
    draft.status = req.response.status || null;
    draft.body = await getContent(req);
  }
  await chrome.storage.local.set({ apiov_draft: draft });
  chrome.runtime.sendMessage({ type: 'apiov:open-editor' });
}

chrome.devtools.panels.setOpenResourceHandler((resource) => {
  if (resource && resource.url) openEditorFor(resource.url);
});

// Tell the background we're loaded (the popup shows this as a status line).
try { chrome.runtime.sendMessage({ type: 'apiov:devtools-loaded', tabId: chrome.devtools.inspectedWindow.tabId }); } catch (_) {}

// ---------- Optional DevTools tab ----------
chrome.storage.local.get('apiov_settings', ({ apiov_settings: s }) => {
  if (!s || !s.devtoolsPanel) return;
  chrome.devtools.panels.create('Doppel', 'icons/icon32.png', 'panel.html', (panel) => {
    panel.onShown.addListener((win) => {
      if (win.__apiovConnected || typeof win.apiovConnect !== 'function') return;
      win.__apiovConnected = true;
      win.apiovConnect({
        entries: entries.slice(),
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
      });
    });
  });
});
