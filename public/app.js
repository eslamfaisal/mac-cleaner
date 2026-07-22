'use strict';

const TOKEN = document.querySelector('meta[name="token"]').content;

// ------------------------------------------------------------- state ------

const state = {
  groups: [],
  items: new Map(),          // id -> item
  selection: new Set(),
  scan: { status: 'idle', tasksDone: 0, tasksTotal: 0 },
  disk: null,
  reclaimed: 0,
  commands: [],
  filters: {
    q: '',
    safety: null,            // null | 'safe' | 'caution' | 'risky'
    minBytes: 10 * 1024 * 1024,
  },
  mode: localStorage.getItem('cleaner-mode') || 'rm',
  collapsed: new Set(JSON.parse(localStorage.getItem('cleaner-collapsed') || '[]')),
};

let dirty = false;
const markDirty = () => { dirty = true; };

// categorical palette, fixed slot per group id (color follows entity)
const SLOT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const groupColor = new Map();

// ------------------------------------------------------------- utils ------

const $ = (sel) => document.querySelector(sel);

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

function fmtCount(n) { return n.toLocaleString('en-US'); }

async function post(pathname, body) {
  const res = await fetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ------------------------------------------------------------- SSE --------

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    const snap = JSON.parse(e.data);
    // server restarted → our token is dead; reload to fetch the new one
    if (state.bootId && snap.bootId !== state.bootId) { location.reload(); return; }
    state.bootId = snap.bootId;
    state.groups = snap.groups;
    state.scan = snap.scan;
    state.disk = snap.disk;
    state.reclaimed = snap.reclaimed;
    state.commands = snap.commands;
    state.fda = snap.fda;
    state.items = new Map(snap.items.map(i => [i.id, i]));
    for (const id of [...state.selection]) if (!state.items.has(id)) state.selection.delete(id);
    snap.groups.forEach((g, idx) => groupColor.set(g.id, SLOT_COLORS[idx % SLOT_COLORS.length]));
    buildGroupSections();
    buildCommands();
    markDirty();
  });
  es.addEventListener('items', (e) => {
    for (const item of JSON.parse(e.data)) {
      state.items.set(item.id, item);
      if (['deleted', 'gone', 'missing'].includes(item.status)) state.selection.delete(item.id);
      if (item.status === 'error' && item.error) toast(`${item.name}: ${item.error}`, true);
    }
    markDirty();
  });
  es.addEventListener('progress', (e) => { state.scan = JSON.parse(e.data); markDirty(); });
  es.addEventListener('scan', (e) => { state.scan = JSON.parse(e.data); markDirty(); });
  es.addEventListener('walk', (e) => { $('#walk-dir').textContent = 'scanning ' + JSON.parse(e.data).dir; });
  es.addEventListener('disk', (e) => { state.disk = JSON.parse(e.data); markDirty(); });
  es.addEventListener('reclaimed', (e) => { state.reclaimed = JSON.parse(e.data).bytes; markDirty(); });
  es.addEventListener('fda', (e) => { state.fda = JSON.parse(e.data).granted; markDirty(); });
  es.onerror = () => { /* EventSource auto-reconnects; hello resyncs */ };
}

// ------------------------------------------------------------- DOM build --

const groupEls = new Map();  // groupId -> {section, body, size, count, hidden, check}
const rowEls = new Map();    // itemId -> row element

function buildGroupSections() {
  const container = $('#groups');
  container.innerHTML = '';
  groupEls.clear();
  rowEls.clear();
  for (const g of state.groups) {
    const section = document.createElement('div');
    section.className = 'group' + (state.collapsed.has(g.id) ? ' collapsed' : '');
    section.hidden = true;
    section.innerHTML = `
      <div class="group-header">
        <input type="checkbox" title="Select group" aria-label="Select all in ${g.title}">
        <span class="g-icon">${g.icon}</span>
        <span class="g-title">${g.title}</span>
        <span class="g-count"></span>
        <span class="g-hidden"></span>
        <span class="g-size"></span>
        <span class="g-chevron">▾</span>
      </div>
      <div class="group-body"></div>`;
    const header = section.querySelector('.group-header');
    const check = section.querySelector('input');
    header.addEventListener('click', (e) => {
      if (e.target === check) return;
      section.classList.toggle('collapsed');
      if (section.classList.contains('collapsed')) state.collapsed.add(g.id); else state.collapsed.delete(g.id);
      localStorage.setItem('cleaner-collapsed', JSON.stringify([...state.collapsed]));
    });
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      // operate on ALL selectable items of the group (not just filtered-visible
      // ones) so the checkbox always reflects what would actually be deleted
      const items = [...state.items.values()].filter(i => i.group === g.id && selectable(i));
      for (const i of items) check.checked ? state.selection.add(i.id) : state.selection.delete(i.id);
      markDirty();
    });
    container.appendChild(section);
    groupEls.set(g.id, {
      section,
      body: section.querySelector('.group-body'),
      count: section.querySelector('.g-count'),
      hidden: section.querySelector('.g-hidden'),
      size: section.querySelector('.g-size'),
      check,
    });
  }
}

function buildCommands() {
  const grid = $('#cmd-grid');
  grid.innerHTML = '';
  for (const c of state.commands) {
    const card = document.createElement('div');
    card.className = 'cmd-card';
    card.innerHTML = `
      <div class="c-title"></div>
      <div class="c-desc"></div>
      <div class="c-row"><code></code><button class="btn" style="padding:4px 10px;font-size:12px">Copy</button></div>`;
    card.querySelector('.c-title').textContent = c.title;
    card.querySelector('.c-desc').textContent = c.desc;
    card.querySelector('code').textContent = c.cmd;
    card.querySelector('button').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(c.cmd);
      e.target.textContent = 'Copied ✓';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    });
    grid.appendChild(card);
  }
}

// ------------------------------------------------------------- filters ----

function selectable(i) {
  return !i.displayOnly && !['deleted', 'gone', 'missing', 'deleting', 'queued'].includes(i.status);
}

function passesFilters(i) {
  if (['missing'].includes(i.status)) return false;
  if (state.filters.safety && i.safety !== state.filters.safety) return false;
  if (i.bytes < state.filters.minBytes && i.status !== 'scanning' && i.status !== 'denied') return false;
  if (state.filters.q) {
    const q = state.filters.q.toLowerCase();
    if (!i.name.toLowerCase().includes(q) && !i.display.toLowerCase().includes(q)) return false;
  }
  return true;
}

function visibleItems() {
  return [...state.items.values()].filter(passesFilters);
}

// ------------------------------------------------------------- render -----

setInterval(() => { if (dirty) { dirty = false; render(); } }, 250);

function render() {
  renderHeader();
  renderSummary();
  renderGroups();
  renderSelectionBar();
}

function renderHeader() {
  const { status, tasksDone, tasksTotal } = state.scan;
  const btn = $('#scan-btn');
  if (status === 'scanning') { btn.textContent = 'Stop scan'; btn.classList.remove('btn-primary'); }
  else if (status === 'idle') { btn.textContent = 'Start Scan'; btn.classList.add('btn-primary'); }
  else { btn.textContent = 'Rescan'; btn.classList.add('btn-primary'); }

  $('#progress-row').hidden = status !== 'scanning';
  if (status === 'scanning') {
    const pct = tasksTotal ? Math.round(tasksDone / tasksTotal * 100) : 0;
    $('#progress-fill').style.width = pct + '%';
    $('#progress-count').textContent = `${fmtCount(tasksDone)} / ${fmtCount(tasksTotal)} tasks`;
  } else {
    $('#walk-dir').textContent = '';
  }

  $('#reclaimed').textContent = '♻️ ' + fmtBytes(state.reclaimed);

  if (state.disk) {
    const used = state.disk.total - state.disk.free;
    const usedPct = used / state.disk.total * 100;
    let cleanable = 0;
    for (const i of state.items.values()) if ((i.status === 'done' || i.status === 'scanning') && !i.noTotal) cleanable += i.bytes;
    const cleanPct = Math.min(cleanable / state.disk.total * 100, usedPct);
    $('#disk-used').style.width = usedPct + '%';
    const cl = $('#disk-clean');
    cl.style.left = (usedPct - cleanPct) + '%';
    cl.style.width = cleanPct + '%';
    $('#disk-label').textContent =
      `${fmtBytes(used)} used · ${fmtBytes(state.disk.free)} free · ${fmtBytes(cleanable)} cleanable found`;
  }

  const hasItems = state.items.size > 0;
  $('#hero').hidden = hasItems || status === 'scanning';
  $('#summary').hidden = !hasItems;
  $('#controls').hidden = !hasItems;
  $('#commands').hidden = !hasItems;

  let deniedCount = 0;
  for (const i of state.items.values()) if (i.status === 'denied' || i.denied > 0) deniedCount++;
  $('#fda-banner').hidden = state.fda !== false && deniedCount < 3;
}

function renderSummary() {
  const totals = { all: 0, safe: 0, caution: 0, risky: 0 };
  const byGroup = new Map();
  for (const i of state.items.values()) {
    if (['deleted', 'gone', 'missing'].includes(i.status) || i.noTotal) continue;
    totals.all += i.bytes;
    totals[i.safety] += i.bytes;
    byGroup.set(i.group, (byGroup.get(i.group) || 0) + i.bytes);
  }
  $('#tile-total .tile-value').textContent = fmtBytes(totals.all);
  for (const s of ['safe', 'caution', 'risky']) {
    const tile = document.querySelector(`.tile-safety[data-safety="${s}"]`);
    tile.querySelector('.tile-value').textContent = fmtBytes(totals[s]);
    tile.classList.toggle('active', state.filters.safety === s);
  }

  // stacked category bar: top 8 by size + other; color fixed per group
  const sorted = [...byGroup.entries()].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 8);
  const otherBytes = sorted.slice(8).reduce((s, [, b]) => s + b, 0);
  const bar = $('#catbar');
  const legend = $('#catbar-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  const total = totals.all || 1;
  const segs = [...top.map(([gid, b]) => ({ gid, b, color: groupColor.get(gid) }))];
  if (otherBytes > 0) segs.push({ gid: null, b: otherBytes, color: 'var(--c-other)' });
  for (const s of segs) {
    const g = state.groups.find(x => x.id === s.gid);
    const title = g ? g.title : 'Other';
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.width = (s.b / total * 100) + '%';
    seg.style.background = s.color;
    seg.title = `${title} — ${fmtBytes(s.b)}`;
    bar.appendChild(seg);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="swatch" style="background:${s.color}"></span><span></span> <span class="size"></span>`;
    chip.children[1].textContent = title;
    chip.children[2].textContent = fmtBytes(s.b);
    legend.appendChild(chip);
  }
}

function renderGroups() {
  const visByGroup = new Map();
  const allByGroup = new Map();
  for (const i of state.items.values()) {
    if (['missing'].includes(i.status)) continue;
    if (!allByGroup.has(i.group)) allByGroup.set(i.group, []);
    allByGroup.get(i.group).push(i);
    if (passesFilters(i)) {
      if (!visByGroup.has(i.group)) visByGroup.set(i.group, []);
      visByGroup.get(i.group).push(i);
    }
  }

  for (const g of state.groups) {
    const els = groupEls.get(g.id);
    if (!els) continue;
    const all = allByGroup.get(g.id) || [];
    const vis = (visByGroup.get(g.id) || []).sort((a, b) => b.bytes - a.bytes);
    els.section.hidden = all.length === 0;
    if (all.length === 0) continue;

    const totalBytes = all.reduce((s, i) => ['deleted', 'gone'].includes(i.status) ? s : s + i.bytes, 0);
    els.size.textContent = fmtBytes(totalBytes);
    els.count.textContent = `${fmtCount(vis.length)} item${vis.length === 1 ? '' : 's'}`;
    const hiddenCount = all.length - vis.length;
    els.hidden.textContent = hiddenCount > 0 ? `(${fmtCount(hiddenCount)} filtered out)` : '';

    const selectableAll = all.filter(selectable);
    const selCount = selectableAll.filter(i => state.selection.has(i.id)).length;
    els.check.checked = selCount > 0 && selCount === selectableAll.length;
    els.check.indeterminate = selCount > 0 && selCount < selectableAll.length;

    // keyed reconcile: update/insert rows in sorted order
    const seen = new Set();
    let cursor = null;
    const place = (row) => {
      if (cursor ? cursor.nextSibling !== row : els.body.firstChild !== row) {
        els.body.insertBefore(row, cursor ? cursor.nextSibling : els.body.firstChild);
      }
      cursor = row;
    };

    if (g.id === 'projects') {
      // cluster by project: sort projects by total desc, subheader per project
      const byProject = new Map();
      for (const item of vis) {
        const key = item.project || '(other)';
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key).push(item);
      }
      const clusters = [...byProject.entries()]
        .map(([proj, items]) => ({ proj, items, total: items.reduce((s, i) => ['deleted', 'gone'].includes(i.status) ? s : s + i.bytes, 0) }))
        .sort((a, b) => b.total - a.total);
      for (const c of clusters) {
        const phId = 'ph:' + c.proj;
        seen.add(phId);
        let ph = rowEls.get(phId);
        if (!ph) { ph = buildProjectHeader(phId, c.proj); rowEls.set(phId, ph); }
        updateProjectHeader(ph, c);
        place(ph);
        for (const item of c.items.sort((a, b) => b.bytes - a.bytes)) {
          seen.add(item.id);
          let row = rowEls.get(item.id);
          if (!row) { row = buildRow(item); rowEls.set(item.id, row); }
          updateRow(row, item);
          row.classList.add('row-indent');
          place(row);
        }
      }
    } else {
      for (const item of vis) {
        seen.add(item.id);
        let row = rowEls.get(item.id);
        if (!row) { row = buildRow(item); rowEls.set(item.id, row); }
        updateRow(row, item);
        place(row);
      }
    }
    // remove rows no longer visible in this group
    for (const row of [...els.body.children]) {
      if (!seen.has(row.dataset.id)) { row.remove(); rowEls.delete(row.dataset.id); }
    }
  }
}

function projectItems(proj) {
  return [...state.items.values()].filter(i =>
    i.group === 'projects' && (i.project || '(other)') === proj && passesFilters(i));
}

function buildProjectHeader(phId, proj) {
  const el = document.createElement('div');
  el.className = 'prow-header';
  el.dataset.id = phId;
  el.innerHTML = `
    <input type="checkbox" aria-label="Select all artifacts of this project">
    <span class="ph-icon">📁</span>
    <span class="ph-name"></span>
    <span class="ph-count"></span>
    <span class="ph-size"></span>`;
  el.querySelector('.ph-name').textContent = proj;
  el.querySelector('input').addEventListener('change', (e) => {
    for (const i of projectItems(proj)) {
      if (!selectable(i)) continue;
      e.target.checked ? state.selection.add(i.id) : state.selection.delete(i.id);
    }
    markDirty();
  });
  return el;
}

function updateProjectHeader(ph, c) {
  ph.querySelector('.ph-size').textContent = fmtBytes(c.total);
  ph.querySelector('.ph-count').textContent = `${fmtCount(c.items.length)} artifact${c.items.length === 1 ? '' : 's'}`;
  const selectableItems = c.items.filter(selectable);
  const sel = selectableItems.filter(i => state.selection.has(i.id)).length;
  const check = ph.querySelector('input');
  check.checked = sel > 0 && sel === selectableItems.length;
  check.indeterminate = sel > 0 && sel < selectableItems.length;
  check.disabled = selectableItems.length === 0;
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = item.id;
  row.innerHTML = `
    <input type="checkbox" aria-label="Select item">
    <div class="r-main">
      <div class="r-name"><span class="nm"></span></div>
      <div class="r-path"></div>
    </div>
    <div class="r-status"></div>
    <div class="r-size"></div>
    <div class="r-actions">
      <button class="icon-btn act-reveal" title="Reveal in Finder">🔍</button>
      <button class="icon-btn act-delete" title="Delete this item">🗑️</button>
    </div>`;
  row.querySelector('input').addEventListener('change', (e) => {
    e.target.checked ? state.selection.add(item.id) : state.selection.delete(item.id);
    markDirty();
  });
  row.querySelector('.act-reveal').addEventListener('click', () => post('/api/reveal', { id: item.id }).catch(e => toast(e.message, true)));
  row.querySelector('.act-delete').addEventListener('click', () => {
    const current = state.items.get(item.id);
    if (current && selectable(current)) openModal([current.id]);
  });
  return row;
}

function updateRow(row, item) {
  row.className = 'row status-' + item.status + (item.displayOnly ? ' display-only' : '');
  const check = row.querySelector('input');
  check.checked = state.selection.has(item.id);
  check.disabled = !selectable(item);

  const nameEl = row.querySelector('.r-name');
  const badgeSig = [item.safety, ...(item.badges || [])].join('|');
  if (row.dataset.badgeSig !== badgeSig || nameEl.querySelector('.nm').textContent !== item.name) {
    row.dataset.badgeSig = badgeSig;
    nameEl.innerHTML = '<span class="nm"></span>';
    nameEl.querySelector('.nm').textContent = item.name;
    const sb = document.createElement('span');
    sb.className = 'badge badge-safety-' + item.safety;
    sb.textContent = item.safety;
    nameEl.appendChild(sb);
    for (const b of item.badges || []) {
      const el = document.createElement('span');
      el.className = 'badge badge-info';
      el.textContent = b;
      nameEl.appendChild(el);
    }
    row.title = (item.why ? item.why : '') + (item.regen ? '\n↩ ' + item.regen : '');
  }
  row.querySelector('.r-path').textContent = item.display;

  const statusEl = row.querySelector('.r-status');
  if (item.status === 'scanning') statusEl.innerHTML = '<span class="spinner"></span>';
  else if (item.status === 'queued') statusEl.textContent = 'queued…';
  else if (item.status === 'deleting') statusEl.innerHTML = '<span class="spinner"></span> deleting';
  else if (item.status === 'deleted') statusEl.textContent = 'deleted ✓';
  else if (item.status === 'gone') statusEl.textContent = 'removed';
  else if (item.status === 'denied') statusEl.textContent = '🔒 no access';
  else if (item.status === 'error') statusEl.textContent = '⚠ ' + (item.error || 'failed');
  else if (item.displayOnly) statusEl.textContent = 'read-only';
  else statusEl.textContent = item.files ? fmtCount(item.files) + ' files' : '';

  row.querySelector('.r-size').textContent = fmtBytes(item.bytes);
}

function renderSelectionBar() {
  const ids = [...state.selection].filter(id => { const i = state.items.get(id); return i && selectable(i); });
  const bar = $('#selection-bar');
  bar.hidden = ids.length === 0;
  if (ids.length) {
    let bytes = 0;
    for (const id of ids) bytes += state.items.get(id).bytes;
    $('#sel-count').textContent = fmtCount(ids.length);
    $('#sel-size').textContent = fmtBytes(bytes);
  }
}

// ------------------------------------------------------------- modal ------

let modalIds = [];

function openModal(ids) {
  modalIds = ids.filter(id => { const i = state.items.get(id); return i && selectable(i); });
  if (!modalIds.length) return;
  const items = modalIds.map(id => state.items.get(id)).sort((a, b) => b.bytes - a.bytes);
  const risky = items.filter(i => i.safety === 'risky');
  const normal = items.filter(i => i.safety !== 'risky');
  const total = items.reduce((s, i) => s + i.bytes, 0);

  const permanentOnly = items.filter(i => i.permanentOnly);
  let modeText = state.mode === 'trash'
    ? 'Items will be moved to Trash (restorable until you empty it).'
    : 'Items will be deleted permanently — this cannot be undone.';
  if (state.mode === 'trash' && permanentOnly.length) {
    modeText += ` ⚠️ ${permanentOnly.map(i => i.name).join(', ')}: always deleted permanently — cannot be restored.`;
  }
  $('#modal-mode').textContent = modeText;

  const fill = (el, list) => {
    el.innerHTML = '';
    for (const i of list.slice(0, 40)) {
      const r = document.createElement('div');
      r.className = 'm-row';
      r.innerHTML = `<span class="dot dot-${i.safety}"></span><span class="m-name"></span><span class="m-size"></span>`;
      r.querySelector('.m-name').textContent = i.name + '  ·  ' + i.display;
      r.querySelector('.m-size').textContent = fmtBytes(i.bytes);
      el.appendChild(r);
    }
    if (list.length > 40) {
      const r = document.createElement('div');
      r.className = 'm-row';
      r.textContent = `… and ${fmtCount(list.length - 40)} more`;
      el.appendChild(r);
    }
  };
  fill($('#modal-list'), normal);
  $('#modal-list').style.display = normal.length ? '' : 'none';
  $('#modal-risky').hidden = risky.length === 0;
  if (risky.length) { fill($('#modal-risky-list'), risky); $('#risky-ack').checked = false; }
  $('#modal-total').textContent = `${fmtCount(items.length)} items — ${fmtBytes(total)}`;
  updateModalConfirm();
  $('#modal').hidden = false;
}

function updateModalConfirm() {
  const risky = modalIds.some(id => state.items.get(id)?.safety === 'risky');
  $('#modal-confirm').disabled = risky && !$('#risky-ack').checked;
  $('#modal-confirm').textContent = state.mode === 'trash' ? 'Move to Trash' : 'Delete permanently';
}

$('#risky-ack').addEventListener('change', updateModalConfirm);
$('#modal-cancel').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').hidden = true; });
$('#modal-confirm').addEventListener('click', async () => {
  $('#modal').hidden = true;
  // items may have changed state while the modal was open — re-filter
  modalIds = modalIds.filter(id => { const i = state.items.get(id); return i && selectable(i); });
  if (!modalIds.length) { toast('Nothing left to clean — items changed while confirming.'); return; }
  try {
    const r = await post('/api/delete', { ids: modalIds, mode: state.mode });
    toast(`Cleaning ${r.accepted.length} item${r.accepted.length === 1 ? '' : 's'}…`);
    for (const id of modalIds) state.selection.delete(id);
    markDirty();
  } catch (e) { toast('Delete failed: ' + e.message, true); }
});

// ------------------------------------------------------------- wire up ----

$('#scan-btn').addEventListener('click', () => {
  if (state.scan.status === 'scanning') post('/api/scan/cancel').catch(e => toast(e.message, true));
  else post('/api/scan/start').catch(e => toast(e.message, true));
});
$('#hero-scan').addEventListener('click', () => post('/api/scan/start').catch(e => toast(e.message, true)));
$('#fda-open').addEventListener('click', () => post('/api/settings/fda').catch(e => toast(e.message, true)));

$('#search').addEventListener('input', (e) => { state.filters.q = e.target.value.trim(); markDirty(); });
$('#min-size').addEventListener('change', (e) => { state.filters.minBytes = Number(e.target.value); markDirty(); });

for (const tile of document.querySelectorAll('.tile-safety')) {
  tile.addEventListener('click', () => {
    const s = tile.dataset.safety;
    state.filters.safety = state.filters.safety === s ? null : s;
    markDirty();
  });
}

$('#select-safe').addEventListener('click', () => {
  for (const i of visibleItems()) {
    if (i.safety === 'safe' && selectable(i) && !(i.badges || []).includes('active project')) state.selection.add(i.id);
  }
  markDirty();
});
$('#select-none').addEventListener('click', () => { state.selection.clear(); markDirty(); });
$('#sel-clear').addEventListener('click', () => { state.selection.clear(); markDirty(); });
$('#sel-clean').addEventListener('click', () => openModal([...state.selection]));

const modeToggle = $('#mode-toggle');
function renderMode() {
  for (const b of modeToggle.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
  }
}
modeToggle.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.mode = b.dataset.mode;
  localStorage.setItem('cleaner-mode', state.mode);
  renderMode();
});
renderMode();
connect();
