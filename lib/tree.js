(function (g) {
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function normalizeGroup(x) {
    const out = {
      id: x.id || uid(),
      name: typeof x.name === 'string' ? x.name : '',
      parentId: x.parentId || null,
      enabled: x.enabled !== false,
      createdAt: x.createdAt || 0,
      updatedAt: x.updatedAt || 0
    };
    if (typeof x.sort === 'number') out.sort = x.sort;
    return out;
  }

  function parentMap(groups) {
    const ids = new Set(groups.map((x) => x.id));
    const parent = new Map(groups.map((x) => [x.id, ids.has(x.parentId) ? x.parentId : null]));
    for (const x of groups) {
      const seen = new Set([x.id]);
      let p = parent.get(x.id);
      while (p) {
        if (seen.has(p)) {
          parent.set(x.id, null);
          break;
        }
        seen.add(p);
        p = parent.get(p);
      }
    }
    return parent;
  }

  const groupOf = (groups, item) => {
    const id = item.groupId || null;
    return id && groups.some((x) => x.id === id) ? id : null;
  };

  function children(rules, groups, parentId) {
    const pid = parentId || null;
    const parent = parentMap(groups);
    const gs = groups.filter((x) => parent.get(x.id) === pid);
    const rs = rules.filter((r) => groupOf(groups, r) === pid);
    return APIOV_MATCH.sortSiblings(gs, rs);
  }

  const childGroups = (groups, parentId) =>
    children([], groups, parentId)
      .filter((c) => c.type === 'g')
      .map((c) => c.item);
  const childRules = (rules, groups, groupId) =>
    children(rules, groups, groupId)
      .filter((c) => c.type === 'r')
      .map((c) => c.item);

  function descendantIds(groups, id) {
    const parent = parentMap(groups);
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of groups)
        if (!out.has(x.id) && out.has(parent.get(x.id))) {
          out.add(x.id);
          grew = true;
        }
    }
    return out;
  }

  function ancestors(groups, id) {
    const parent = parentMap(groups);
    const out = [];
    let p = id && parent.has(id) ? id : null;
    while (p) {
      out.unshift(groups.find((x) => x.id === p));
      p = parent.get(p);
    }
    return out;
  }

  const parentOf = (groups, id) => (id ? parentMap(groups).get(id) || null : null);

  function isOn(groups, groupId) {
    return ancestors(groups, groupId).every((x) => x.enabled !== false);
  }

  function counts(rules, groups, groupId) {
    const ids = descendantIds(groups, groupId);
    const inside = rules.filter((r) => ids.has(groupOf(groups, r)));
    const active = inside.filter((r) => r.enabled && isOn(groups, groupOf(groups, r))).length;
    return { total: inside.length, active, groups: ids.size - 1 };
  }

  function flatGroups(groups) {
    const out = [];
    const walk = (pid, depth) => {
      for (const x of childGroups(groups, pid)) {
        out.push({ group: x, depth });
        walk(x.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }

  function renumber(rules, groups, order, parentId) {
    const pos = new Map(order.map((c, i) => [c.type + c.item.id, i]));
    const now = Date.now();
    const fix = (type, key) => (x) => {
      const i = pos.get(type + x.id);
      if (i === undefined) return x;
      if (x.sort === i && (x[key] || null) === (parentId || null)) return x;
      return { ...x, sort: i, [key]: parentId || null, updatedAt: now };
    };
    return { rules: rules.map(fix('r', 'groupId')), groups: groups.map(fix('g', 'parentId')) };
  }

  const find = (rules, groups, ref) => (ref.type === 'g' ? groups : rules).find((x) => x.id === ref.id);

  function placeItem(rules, groups, ref, { parentId = null, index = 0 } = {}) {
    const item = find(rules, groups, ref);
    if (!item) return null;
    if (ref.type === 'g' && parentId && descendantIds(groups, ref.id).has(parentId)) return null;
    const sibs = children(rules, groups, parentId).filter((c) => !(c.type === ref.type && c.item.id === ref.id));
    const i = Math.max(0, Math.min(index, sibs.length));
    sibs.splice(i, 0, { type: ref.type, item });
    return renumber(rules, groups, sibs, parentId);
  }

  function containerOf(rules, groups, ref) {
    const item = find(rules, groups, ref);
    if (!item) return null;
    return ref.type === 'g' ? parentOf(groups, ref.id) : groupOf(groups, item);
  }

  function indexIn(rules, groups, ref) {
    const pid = containerOf(rules, groups, ref);
    return children(rules, groups, pid).findIndex((c) => c.type === ref.type && c.item.id === ref.id);
  }

  function shiftItem(rules, groups, ref, dir) {
    const pid = containerOf(rules, groups, ref);
    return placeItem(rules, groups, ref, { parentId: pid, index: Math.max(0, indexIn(rules, groups, ref) + dir) });
  }

  const toTop = (rules, groups, ref) =>
    placeItem(rules, groups, ref, { parentId: containerOf(rules, groups, ref), index: 0 });

  function removeGroup(rules, groups, id, keepContents) {
    const x = groups.find((y) => y.id === id);
    if (!x) return { rules, groups };
    const up = parentOf(groups, id);
    if (keepContents) {
      const order = children(rules, groups, up).flatMap((c) =>
        c.type === 'g' && c.item.id === id ? children(rules, groups, id) : [c]
      );
      const res = renumber(rules, groups, order, up);
      return { rules: res.rules, groups: res.groups.filter((y) => y.id !== id) };
    }
    const gone = descendantIds(groups, id);
    return {
      groups: groups.filter((y) => !gone.has(y.id)),
      rules: rules.filter((r) => !gone.has(groupOf(groups, r)))
    };
  }

  function exportData(rules, groups, { ruleIds, groupIds }) {
    const gSet = new Set(groupIds);
    const rSet = new Set(ruleIds);
    const parent = parentMap(groups);
    const outGroups = groups
      .filter((x) => gSet.has(x.id))
      .map((x) => ({ ...x, parentId: gSet.has(parent.get(x.id)) ? parent.get(x.id) : null }));
    const outRules = rules
      .filter((r) => rSet.has(r.id))
      .map((r) => ({ ...r, groupId: gSet.has(groupOf(groups, r)) ? groupOf(groups, r) : null }));
    return { app: 'doppel', version: 2, exportedAt: Date.now(), groups: outGroups, rules: outRules };
  }

  function exportGroup(rules, groups, id) {
    const ids = descendantIds(groups, id);
    return exportData(rules, groups, {
      groupIds: [...ids],
      ruleIds: rules.filter((r) => ids.has(groupOf(groups, r))).map((r) => r.id)
    });
  }

  function parseImport(data) {
    const list = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : [];
    const rules = list.filter((r) => r && typeof r.pattern === 'string' && r.pattern);
    const groups = (data && Array.isArray(data.groups) ? data.groups : []).filter((x) => x && x.id).map(normalizeGroup);
    return { rules, groups };
  }

  function importData(rules, groups, incoming, targetGroupId = null) {
    const taken = new Set([...rules.map((r) => r.id), ...groups.map((x) => x.id)]);
    const fresh = (id) => {
      let n = id && !taken.has(id) ? id : uid();
      while (taken.has(n)) n = uid();
      taken.add(n);
      return n;
    };
    const idMap = new Map(incoming.groups.map((x) => [x.id, fresh(x.id)]));
    const now = Date.now();
    const newGroups = incoming.groups.map((x) => ({
      ...x,
      id: idMap.get(x.id),
      parentId: idMap.get(x.parentId) || targetGroupId || null,
      updatedAt: now
    }));
    const newRules = incoming.rules.map((r) => ({
      ...r,
      id: fresh(r.id),
      groupId: idMap.get(r.groupId) || targetGroupId || null,
      updatedAt: now
    }));
    const allRules = [...newRules, ...rules];
    const allGroups = [...newGroups, ...groups];
    const isNew = new Set([...newRules, ...newGroups].map((x) => x.id));
    const top = children(allRules, allGroups, targetGroupId);
    const order = [...top.filter((c) => isNew.has(c.item.id)), ...top.filter((c) => !isNew.has(c.item.id))];
    return { ...renumber(allRules, allGroups, order, targetGroupId), added: newRules.length };
  }

  g.APIOV_TREE = {
    normalizeGroup,
    groupOf,
    children,
    childGroups,
    childRules,
    descendantIds,
    ancestors,
    parentOf,
    isOn,
    counts,
    flatGroups,
    placeItem,
    containerOf,
    indexIn,
    shiftItem,
    toTop,
    removeGroup,
    exportData,
    exportGroup,
    parseImport,
    importData
  };
})(globalThis);
