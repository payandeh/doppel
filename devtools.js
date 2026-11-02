const MAX = 1500;
const entries = [];
const applied = []; // what the page actually received for overridden requests
const subs = new Set();
const emit = (msg) =>
  subs.forEach((fn) => {
    try {
      fn(msg);
    } catch (_) {
      subs.delete(fn);
    }
  });

chrome.devtools.network.onRequestFinished.addListener((req) => {
  entries.push(req);
  if (entries.length > MAX) entries.shift();
  emit({ type: 'add', req });
});
const tabId = chrome.devtools.inspectedWindow.tabId;
function onApplied(rec) {
  if (!rec || typeof rec.url !== 'string') return;
  applied.push(rec);
  if (applied.length > MAX) applied.shift();
  emit({ type: 'applied', rec });
}
// From the page-level patch (via content/bridge.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'apiov:applied' && sender.tab && sender.tab.id === tabId) onApplied(msg.rec);
});
// From the network-level mode (lib/native.js). The open port also tells the background DevTools is open.
let port = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: 'apiov-devtools:' + tabId });
    port.onMessage.addListener((msg) => msg && msg.type === 'applied' && onApplied(msg.rec));
    // The service worker can restart; reconnect so it knows DevTools is still open.
    port.onDisconnect.addListener(() => setTimeout(connect, 500));
  } catch (_) {}
}
connect();

chrome.devtools.network.onNavigated.addListener((url) => emit({ type: 'navigated', url }));

function getContent(req) {
  return new Promise((resolve) => {
    try {
      req.getContent((content, encoding) => {
        if (content && encoding === 'base64') {
          try {
            content = new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
          } catch (_) {}
        }
        resolve(content || '');
      });
    } catch (_) {
      resolve('');
    }
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

try {
  chrome.runtime.sendMessage({ type: 'apiov:devtools-loaded', tabId: chrome.devtools.inspectedWindow.tabId });
} catch (_) {}

chrome.storage.local.get('apiov_settings', ({ apiov_settings: s }) => {
  if (!s || !s.devtoolsPanel) return;
  chrome.devtools.panels.create('Doppel', 'icons/icon32.png', 'panel.html', (panel) => {
    panel.onShown.addListener((win) => {
      if (win.__apiovConnected || typeof win.apiovConnect !== 'function') return;
      win.__apiovConnected = true;
      win.apiovConnect({
        entries: entries.slice(),
        applied: applied.slice(),
        subscribe(fn) {
          subs.add(fn);
          return () => subs.delete(fn);
        }
      });
    });
  });
});
