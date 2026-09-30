// apiov_rev changes on every local edit; apiov_folder.syncedRev and .fileMtime record both sides at the last sync.
const FolderSync = (() => {
  const FILE = 'doppel.json';
  const LEGACY_FILES = ['api-overrides.json'];
  const DB = 'apiov-folder',
    STORE = 'kv',
    HANDLE_KEY = 'dir';
  const g = typeof self !== 'undefined' ? self : window;

  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        d.close();
        res(req && req.result);
      };
      tx.onerror = () => {
        d.close();
        rej(tx.error);
      };
    });
  }
  const getHandle = () => idb('readonly', (s) => s.get(HANDLE_KEY));
  const setHandle = (h) => idb('readwrite', (s) => s.put(h, HANDLE_KEY));
  const clearHandle = () => idb('readwrite', (s) => s.delete(HANDLE_KEY));

  const getMeta = async () => (await chrome.storage.local.get('apiov_folder')).apiov_folder || null;
  const setMeta = (m) => chrome.storage.local.set({ apiov_folder: m });

  async function permission(handle, ask = false) {
    const opts = { mode: 'readwrite' };
    try {
      let p = await handle.queryPermission(opts);
      if (p !== 'granted' && ask && handle.requestPermission) p = await handle.requestPermission(opts);
      return p;
    } catch (_) {
      return 'prompt';
    }
  }

  async function readFile(dir) {
    let fh = null;
    let legacy = false;
    for (const name of [FILE, ...LEGACY_FILES]) {
      try {
        fh = await dir.getFileHandle(name);
        legacy = name !== FILE;
        break;
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
      }
    }
    if (!fh) return null;
    const f = await fh.getFile();
    const text = await f.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const err = new Error(
        `${FILE} in your folder is not valid JSON (${e.message}). Fix or delete the file, then click "Sync now".`
      );
      err.code = 'bad-file';
      throw err;
    }
    const rules = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
    if (!rules) {
      const err = new Error(`${FILE} in your folder doesn't look like a Doppel file.`);
      err.code = 'bad-file';
      throw err;
    }
    return {
      legacy,
      mtime: f.lastModified,
      rules: rules.filter((r) => r && typeof r.pattern === 'string').map(normalize),
      enabled: data.enabled !== false,
      savedAt: data.savedAt || f.lastModified
    };
  }

  async function writeFile(dir, rules, enabled) {
    const fh = await dir.getFileHandle(FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(
      JSON.stringify(
        {
          app: 'doppel',
          version: 1,
          savedAt: Date.now(),
          enabled,
          rules
        },
        null,
        2
      ) + '\n'
    );
    await w.close();
    return (await fh.getFile()).lastModified;
  }

  function normalize(r) {
    return {
      id: r.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: r.name || '',
      enabled: r.enabled !== false,
      method: r.method || 'ANY',
      matchType: r.matchType || 'equals',
      pattern: r.pattern,
      ignoreQuery: !!r.ignoreQuery,
      status: Number.isInteger(r.status) ? r.status : null,
      body: typeof r.body === 'string' ? r.body : '',
      delay: r.delay | 0,
      mockOnly: !!r.mockOnly,
      createdAt: r.createdAt || 0,
      updatedAt: r.updatedAt || 0
    };
  }

  function merge(a, b) {
    const map = new Map();
    for (const r of [...a, ...b]) {
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) map.set(r.id, r);
    }
    const ids = [...new Set([...a.map((r) => r.id), ...b.map((r) => r.id)])];
    return ids.map((id) => map.get(id));
  }

  async function loadLocal() {
    const d = await chrome.storage.local.get(['apiov_rules', 'apiov_enabled', 'apiov_rev']);
    return { rules: d.apiov_rules || [], enabled: d.apiov_enabled !== false, rev: d.apiov_rev || 0 };
  }

  async function applyFile(dir, file, meta) {
    await applyToBrowser(file.rules, file.enabled, meta, file.mtime);
    if (file.legacy) await saveToFolder(dir, await getMeta());
  }

  async function applyToBrowser(rules, enabled, meta, mtime) {
    const rev = Date.now();
    await chrome.storage.local.set({
      apiov_rules: rules,
      apiov_enabled: enabled,
      apiov_rev: rev,
      apiov_folder: { ...meta, syncedRev: rev, fileMtime: mtime, lastSyncAt: Date.now(), error: null }
    });
  }

  async function saveToFolder(dir, meta) {
    const local = await loadLocal();
    const mtime = await writeFile(dir, local.rules, local.enabled);
    await setMeta({ ...meta, syncedRev: local.rev, fileMtime: mtime, lastSyncAt: Date.now(), error: null });
  }

  const withLock = (fn) => (navigator.locks ? navigator.locks.request('apiov-folder-sync', fn) : fn());

  async function sync() {
    return withLock(async () => {
      const meta = await getMeta();
      const dir = await getHandle().catch(() => null);
      if (!meta || !dir) return { state: 'none' };
      if ((await permission(dir)) !== 'granted') return { state: 'needs-permission', name: meta.name };
      try {
        const local = await loadLocal();
        const file = await readFile(dir);
        const localChanged = local.rev !== meta.syncedRev;
        const fileChanged = !!file && file.mtime !== meta.fileMtime;
        if (!file || (localChanged && !fileChanged)) await saveToFolder(dir, meta);
        else if (fileChanged && !localChanged) await applyFile(dir, file, meta);
        else if (fileChanged && localChanged) {
          return { state: 'conflict', name: meta.name, file, local };
        }
        const m = await getMeta();
        return { state: 'ok', name: m.name, lastSyncAt: m.lastSyncAt };
      } catch (e) {
        await setMeta({ ...meta, error: e.message });
        return { state: 'error', name: meta.name, message: e.message };
      }
    });
  }

  async function resolve(choice) {
    return withLock(async () => {
      const meta = await getMeta();
      const dir = await getHandle();
      const local = await loadLocal();
      const file = await readFile(dir);
      if (choice === 'folder' && file) await applyFile(dir, file, meta);
      else if (choice === 'merge' && file) {
        await chrome.storage.local.set({ apiov_rules: merge(local.rules, file.rules), apiov_rev: Date.now() });
        await saveToFolder(dir, meta);
      } else await saveToFolder(dir, meta);
    });
  }

  async function choose() {
    const dir = await g.showDirectoryPicker({ id: 'doppel', mode: 'readwrite', startIn: 'documents' });
    if ((await permission(dir, true)) !== 'granted') throw new Error('Permission to the folder was not granted.');
    await setHandle(dir);
    const meta = { name: dir.name, syncedRev: null, fileMtime: null, lastSyncAt: null, error: null };
    await setMeta(meta);
    const file = await readFile(dir);
    const local = await loadLocal();
    if (!file) {
      await saveToFolder(dir, meta);
      return { needsChoice: false };
    }
    if (!local.rules.length) {
      await applyFile(dir, file, meta);
      return { needsChoice: false, loaded: file.rules.length };
    }
    return { needsChoice: true, file, local };
  }

  async function reconnect() {
    const dir = await getHandle();
    if (!dir) return 'none';
    return permission(dir, true);
  }

  async function disconnect() {
    await clearHandle();
    await chrome.storage.local.remove('apiov_folder');
  }

  let timer = null;
  function watch(onStatus) {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local' || !(c.apiov_rev || c.apiov_rules || c.apiov_enabled)) return;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          sync()
            .then((s) => onStatus && onStatus(s))
            .catch(() => {}),
        250
      );
    });
  }

  return { FILE, sync, resolve, choose, reconnect, disconnect, watch, getMeta };
})();
