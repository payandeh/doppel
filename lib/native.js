// "Native" mode: while DevTools is open on a tab, overrides are applied at the network layer through the
// Chrome debugger (Fetch domain), so Chrome's own Network tab shows the overridden status and body.
// Opt-in (Settings). ("debugger" cannot be an optional permission.)
// To keep Chrome's "started debugging this browser" bar away from unrelated pages, a tab is only attached when
// Doppel is on, DevTools is open on it, and its site has had at least one request overridden by Doppel. A site
// is learned the first time the page-level patch overrides something there; from then on (also after reloads)
// the tab is attached before the page's first request.
// The page-level patch (content/inject.js) steps aside for the top frame of a tab while this is active.
const Native = (() => {
  const KEY_SETTINGS = 'apiov_settings';
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
  const ports = new Map(); // tabId -> Set<Port> (open DevTools windows for that tab)
  const sessions = new Map(); // tabId -> { mainFrameId }
  const attaching = new Map(); // tabId -> Promise
  const tabOrigin = new Map(); // tabId -> origin of the top frame
  const KEY_ORIGINS = 'apiov_native_origins';
  let origins = null; // sites where Doppel has overridden something
  let rules = null;

  const hasBody = (r) => typeof r.body === 'string' && r.body.trim() !== '';
  const hasStatus = (r) => Number.isInteger(r.status) && r.status >= 200 && r.status <= 599;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  async function loadRules() {
    const d = await chrome.storage.local.get(['apiov_rules', 'apiov_enabled', 'apiov_groups']);
    rules =
      d.apiov_enabled === false
        ? []
        : APIOV_MATCH.activeRules((d.apiov_rules || []).filter(Boolean), d.apiov_groups || []);
  }

  async function loadOrigins() {
    if (origins) return;
    const { [KEY_ORIGINS]: list = [] } = await chrome.storage.local.get(KEY_ORIGINS);
    origins = new Set(list);
  }

  async function learnOrigin(origin) {
    await loadOrigins();
    if (!origin || origin === 'null' || origins.has(origin)) return;
    origins.add(origin);
    await chrome.storage.local.set({ [KEY_ORIGINS]: [...origins].slice(-500) });
  }

  async function wanted(tabId) {
    const { [KEY_SETTINGS]: s = {} } = await chrome.storage.local.get(KEY_SETTINGS);
    if (!s.nativeNetwork || !chrome.debugger || !ports.get(tabId)?.size) return false;
    if (!rules) await loadRules();
    await loadOrigins();
    return rules.length > 0 && origins.has(tabOrigin.get(tabId));
  }

  function b64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function tellTab(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'apiov:native', on: sessions.has(tabId) }).catch(() => {});
  }

  function report(tabId, rec) {
    for (const p of ports.get(tabId) || []) {
      try {
        p.postMessage({ type: 'applied', rec });
      } catch (_) {}
    }
  }

  function attach(tabId) {
    if (!attaching.has(tabId))
      attaching.set(
        tabId,
        doAttach(tabId).finally(() => attaching.delete(tabId))
      );
    return attaching.get(tabId);
  }

  async function doAttach(tabId) {
    hookDebugger();
    if (sessions.has(tabId) || !chrome.debugger) return;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (_) {
      return; // e.g. chrome:// pages, or another debugger already attached
    }
    try {
      const { frameTree } = await cmd(tabId, 'Page.getFrameTree');
      sessions.set(tabId, { mainFrameId: frameTree.frame.id });
      await cmd(tabId, 'Fetch.enable', {
        patterns: [
          { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' }
        ]
      });
    } catch (_) {
      sessions.delete(tabId);
      chrome.debugger.detach({ tabId }).catch(() => {});
      return;
    }
    tellTab(tabId);
  }

  async function detach(tabId) {
    await attaching.get(tabId);
    if (!sessions.delete(tabId)) return;
    tellTab(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  async function refresh() {
    const tabs = new Set([...ports.keys(), ...sessions.keys()]);
    await Promise.all([...tabs].map(async (tabId) => ((await wanted(tabId)) ? attach(tabId) : detach(tabId))));
  }

  async function onPaused(tabId, ev) {
    const { requestId, request, frameId } = ev;
    const go = (method, params = {}) => cmd(tabId, method, { requestId, ...params }).catch(() => {});
    const s = sessions.get(tabId);
    // Sub-frames keep using the page-level patch (cross-site iframes are not covered by this session).
    if (!s || frameId !== s.mainFrameId) return go('Fetch.continueRequest');
    if (!rules) await loadRules();
    const rule = APIOV_MATCH.findRule(rules, request.url, request.method);
    if (!rule) return go('Fetch.continueRequest');

    const isResponse = ev.responseStatusCode !== undefined || ev.responseErrorReason !== undefined;
    const mockOnly = rule.mockOnly && hasBody(rule);
    if (!isResponse && !mockOnly) return go('Fetch.continueRequest', { interceptResponse: true });

    const failed = isResponse && ev.responseErrorReason !== undefined;
    if (failed && !hasBody(rule)) return go('Fetch.continueRequest');

    const real = isResponse && !failed ? { status: ev.responseStatusCode, headers: ev.responseHeaders || [] } : null;
    const status = hasStatus(rule) ? rule.status : real ? real.status : 200;
    if (rule.delay > 0) await sleep(rule.delay);
    if (!sessions.has(tabId)) return;

    const rec = {
      url: request.url,
      method: request.method,
      status,
      realStatus: real ? real.status : null,
      body: undefined,
      mocked: !real,
      via: 'network',
      at: Date.now()
    };

    // Marks the row in Chrome's Network tab: visible under Headers, as a column (right-click the table header →
    // Response Headers → Manage Header Columns → add "x-doppel") and with the filter "has-response-header:x-doppel".
    const parts = [];
    if (real && real.status !== status) parts.push(`status ${real.status} -> ${status}`);
    else if (!real) parts.push(`status ${status}`);
    if (hasBody(rule)) parts.push('body');
    if (rule.delay > 0) parts.push(`delay ${rule.delay}ms`);
    const marker = { name: 'x-doppel', value: `${real ? 'overridden' : 'mocked'}: ${parts.join(', ')}` };

    if (hasBody(rule)) {
      const headers = (real ? real.headers : []).filter(
        (h) => !/^(content-type|content-length|content-encoding|x-doppel)$/i.test(h.name)
      );
      headers.push({ name: 'content-type', value: 'application/json; charset=utf-8' }, marker);
      const body = NULL_BODY_STATUS.has(status) ? '' : rule.body;
      rec.body = body;
      await go('Fetch.fulfillRequest', { responseCode: status, responseHeaders: headers, body: b64(body) });
    } else {
      // Status only: keep the real body and headers.
      const headers = real.headers.filter((h) => !/^x-doppel$/i.test(h.name));
      await go('Fetch.continueResponse', { responseCode: status, responseHeaders: [...headers, marker] });
    }
    report(tabId, rec);
  }

  function init() {
    chrome.runtime.onConnect.addListener((port) => {
      const m = /^apiov-devtools:(\d+)$/.exec(port.name);
      if (!m) return;
      const tabId = Number(m[1]);
      if (!ports.has(tabId)) ports.set(tabId, new Set());
      ports.get(tabId).add(port);
      refresh();
      port.onDisconnect.addListener(() => {
        ports.get(tabId)?.delete(port);
        if (!ports.get(tabId)?.size) ports.delete(tabId);
        refresh();
      });
    });

    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (!msg || !sender.tab || sender.frameId !== 0) return;
      const tabId = sender.tab.id;
      const origin = sender.origin || (sender.url ? new URL(sender.url).origin : null);
      // A page (re)loaded: attach before its first request if this site has overrides, detach if not.
      if (msg.type === 'apiov:native?') {
        tabOrigin.set(tabId, origin);
        (async () => {
          if (await wanted(tabId)) await attach(tabId);
          else await detach(tabId);
          reply({ on: sessions.has(tabId) });
        })();
        return true;
      }
      // The page-level patch overrode something: remember the site, and attach if DevTools is open.
      if (msg.type === 'apiov:applied') {
        tabOrigin.set(tabId, origin);
        learnOrigin(origin).then(refresh);
      }
    });

    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local') return;
      if (c.apiov_rules || c.apiov_enabled || c.apiov_groups) loadRules().then(refresh);
      if (c[KEY_SETTINGS]) refresh();
    });
    hookDebugger();
  }

  let hooked = false;
  function hookDebugger() {
    if (hooked || !chrome.debugger) return;
    hooked = true;
    chrome.debugger.onEvent.addListener((src, method, params) => {
      if (method === 'Fetch.requestPaused' && src.tabId) onPaused(src.tabId, params);
    });
    chrome.debugger.onDetach.addListener((src) => {
      // Closed tab, or the user clicked "Cancel" on Chrome's debugging bar: fall back to the page-level patch.
      if (src.tabId && sessions.delete(src.tabId)) tellTab(src.tabId);
    });
  }

  return { init, refresh, isAttached: (tabId) => sessions.has(tabId) };
})();
