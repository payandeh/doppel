const openManager = (hash = '') =>
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') + hash });

mountRulesView(document.getElementById('rules'), {
  compact: true,
  onEdit: (rule, isNew) => openManager(isNew ? '#new' : '#edit=' + rule.id)
});
document.getElementById('manage').addEventListener('click', () => openManager());

// DevTools integration status for the current tab
(async () => {
  const el = document.getElementById('dt-status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const url = tab.url || '';
  if (/^(chrome|edge|about|chrome-extension|devtools):/.test(url) || url.startsWith('https://chromewebstore.google.com')) {
    el.textContent = '⚠ Chrome doesn\'t allow extensions on this page — open your web app\'s tab.';
    el.className = 'dt-status warn';
    return;
  }
  const { at } = await chrome.runtime.sendMessage({ type: 'apiov:devtools-status', tabId: tab.id }) || {};
  if (at) {
    el.textContent = '✓ DevTools menu item is active for this tab.';
    el.className = 'dt-status ok';
  } else {
    el.textContent = '⚠ Menu item not loaded for this tab yet: close DevTools and open it again (needed after installing or reloading the extension). If it still doesn\'t appear, check the extension\'s Site access in chrome://extensions.';
    el.className = 'dt-status warn';
  }
})();

// Folder status
(async () => {
  const el = document.getElementById('folder-status');
  const s = await FolderSync.sync().catch(() => ({ state: 'none' }));
  const link = (text) => `<a href="#" id="folder-link">${text}</a>`;
  if (s.state === 'none') {
    el.innerHTML = '📁 Not saved to a folder — ' + link('choose a folder') + ' so overrides survive reinstalling.';
  } else if (s.state === 'ok') {
    el.textContent = `📁 Saved to folder "${s.name}"`;
    el.className = 'dt-status ok';
  } else {
    el.innerHTML = `⚠ Folder "<span></span>" needs attention — ` + link('open manager');
    el.querySelector('span').textContent = s.name;
    el.className = 'dt-status warn';
  }
  const a = document.getElementById('folder-link');
  if (a) a.addEventListener('click', (e) => { e.preventDefault(); openManager('#folder'); });
})();
