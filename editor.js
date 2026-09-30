(async () => {
  const { apiov_draft: draft } = await chrome.storage.local.get('apiov_draft');
  const { rules, groups } = await APIOV.load();
  const close = () => window.close();

  if (!draft) {
    openRuleEditor({ rule: APIOV.newRule(), isNew: true, standalone: true, onClose: close });
    return;
  }

  const existing = APIOV.findRule(APIOV.inOrder(rules, groups), draft.url, draft.method, true);
  let note;
  if (existing) {
    note = 'An override already matches this request — editing it.';
    openRuleEditor({ rule: existing, originalStatus: draft.status, standalone: true, note, onClose: close });
    return;
  }

  if (!draft.found)
    note = 'Response not found in the Network log (it may have been cleared) — enter the body manually.';
  else if (draft.body && !JsonCheck.validate(draft.body).ok)
    note = 'The current response is not valid JSON — fix it or clear it to keep the original body.';
  const pretty = draft.body ? JsonCheck.format(draft.body) : null;
  openRuleEditor({
    isNew: true,
    standalone: true,
    note,
    originalStatus: draft.status,
    onClose: close,
    rule: APIOV.newRule({
      method: draft.method,
      matchType: 'equals',
      pattern: draft.url,
      status: null,
      body: pretty && pretty.ok ? pretty.text : draft.body || ''
    })
  });
})();
