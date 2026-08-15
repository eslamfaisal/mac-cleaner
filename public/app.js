'use strict';

const TOKEN = document.querySelector('meta[name="token"]').content;

// ------------------------------------------------------------- state ------

function viewFromHash() {
  if (location.hash === '#settings') return { name: 'settings' };
  const m = location.hash.match(/^#g\/(.+)$/);
  return m ? { name: 'group', id: decodeURIComponent(m[1]) } : { name: 'overview' };
}

const state = {
  view: viewFromHash(),
  groups: [],
  normalGroups: [],
  uiMode: 'dev',             // 'normal' | 'dev' — set from server settings
  deleteModes: { normal: 'trash', dev: 'rm' },
  items: new Map(),          // id -> item
  selection: new Set(),
  keep: new Set(),           // absolute paths the user chose to hold on to
  scan: { status: 'idle', tasksDone: 0, tasksTotal: 0 },
  disk: null,
  reclaimed: 0,
  trashed: 0,
  commands: [],
  filters: {
    q: '',
    safety: null,            // null | 'safe' | 'caution' | 'risky'
    minBytes: 10 * 1024 * 1024,
  },
  fdaDismissed: sessionStorage.getItem('cleaner-fda-dismissed') === '1',
  fdaJustGranted: 0,
  sort: 'size',
  scanEndedAt: null,
};

let dirty = false;
const markDirty = () => { dirty = true; };

// categorical palette, fixed slot per group id (color follows entity)
const SLOT_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
const groupColor = new Map();

// ------------------------------------------------------------- mode -------
// One scan, two taxonomies. Everything downstream asks these two helpers
// which categories exist and which one an item belongs to, so switching mode
// is a re-render — never a rescan.

const NORMAL_FALLBACK_GROUP = 'n-dev';

function activeGroups() {
  return state.uiMode === 'normal' ? state.normalGroups : state.groups;
}

function groupOf(item) {
  return state.uiMode === 'normal' ? (item.normalGroup || NORMAL_FALLBACK_GROUP) : item.group;
}

function deleteMode() {
  return state.deleteModes[state.uiMode] || 'rm';
}

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

function fmtAge(mtime) {
  const days = (Date.now() - mtime) / 86400000;
  if (days < 1) return 'today';
  if (days < 30) return Math.round(days) + ' d old';
  if (days < 365) return Math.round(days / 30) + ' mo old';
  return (days / 365).toFixed(1) + ' y old';
}

// "Mediaanalysisd (com.apple.mediaanalysisd) — sandbox cache" is a reasonable
// row for a developer and gibberish for everyone else: in normal mode the
// bundle id and the sandbox wording come off.
function displayName(item) {
  if (state.uiMode !== 'normal') return item.name;
  return item.name
    .replace(/\s*\((?:com|org|net|io|dev|app|us|ru|co|ai)\.[^)]*\)/i, '')
    .replace(/ — (?:sandbox|group) cache$/, ' — cache');
}

function sortItems(arr) {
  const s = state.sort;
  return arr.sort((a, b) =>
    s === 'name' ? a.name.localeCompare(b.name)
    : s === 'files' ? (b.files || 0) - (a.files || 0)
    : s === 'age' ? (a.mtime || Infinity) - (b.mtime || Infinity)
    : b.bytes - a.bytes);
}

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

// ---------------------------------------------------------- settings ------

// uiMode === null means the user has never chosen — the picker takes over the
// screen until they do.
function applySettings(s) {
  if (!s) return;
  state.needsModeChoice = s.uiMode == null;
  state.uiMode = s.uiMode || 'normal';   // picker is showing anyway when null
  if (s.deleteMode) state.deleteModes = { ...state.deleteModes, ...s.deleteMode };
  state.keep = new Set(s.keep || []);
  document.body.classList.toggle('mode-normal', state.uiMode === 'normal');
  $('#mode-onboard').hidden = !state.needsModeChoice;
  renderModeToggles();
}

function saveSettings(patch) {
  post('/api/settings', patch).catch(e => toast('Could not save preference: ' + e.message, true));
}

function setUiMode(mode, { persist = true } = {}) {
  if (mode !== 'normal' && mode !== 'dev') return;
  const changed = state.uiMode !== mode;
  state.uiMode = mode;
  state.needsModeChoice = false;
  document.body.classList.toggle('mode-normal', mode === 'normal');
  $('#mode-onboard').hidden = true;
  if (persist) saveSettings({ uiMode: mode });
  if (changed) {
    // the other taxonomy has different category ids — a detail deep-link into
    // the old one is meaningless now
    if (state.view.name === 'group' && !activeGroups().some(g => g.id === state.view.id)) {
      history.replaceState(null, '', '#');
      state.view = { name: 'overview' };
    }
    buildGroupSections();
    buildCards();
  }
  renderModeToggles();
  markDirty();
}

// "I know about this one and I want to keep it." Without this every scan
// re-asks the same question, and the answer is re-made by hand every time.
function keepItem(id) {
  const item = state.items.get(id);
  if (!item || !item.abs) return;
  state.keep.add(item.abs);
  state.selection.delete(id);
  saveSettings({ keepAdd: item.abs });
  toast(`Keeping ${displayName(item)} — hidden from scans until you restore it.`);
  markDirty();
}

function unkeepAll() {
  state.keep = new Set();
  saveSettings({ keepClear: true });
  markDirty();
}

const isKept = (i) => state.keep.has(i.abs);

function setDeleteMode(mode) {
  if (mode !== 'trash' && mode !== 'rm') return;
  state.deleteModes[state.uiMode] = mode;
  saveSettings({ deleteMode: { [state.uiMode]: mode } });
  renderModeToggles();
  markDirty();
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
    state.normalGroups = snap.normalGroups || [];
    applySettings(snap.settings);
    state.scan = snap.scan;
    state.disk = snap.disk;
    state.reclaimed = snap.reclaimed;
    state.trashed = snap.trashed || 0;
    state.commands = snap.commands;
    state.fda = snap.fda;
    state.appMode = snap.appMode;
    $('#app-version').textContent = snap.version && snap.version !== 'dev' ? 'v' + snap.version : '';
    $('#settings-version').textContent = snap.version ? 'v' + snap.version : '';
    state.items = new Map(snap.items.map(i => [i.id, i]));
    for (const id of [...state.selection]) if (!state.items.has(id)) state.selection.delete(id);
    // one fixed color slot per group id, in both taxonomies
    for (const list of [snap.groups, state.normalGroups]) {
      list.forEach((g, idx) => groupColor.set(g.id, SLOT_COLORS[idx % SLOT_COLORS.length]));
    }
    // stale deep-link (group id not in the active taxonomy) → back to overview
    if (state.view.name === 'group' && !activeGroups().some(g => g.id === state.view.id)) {
      history.replaceState(null, '', '#');
      state.view = { name: 'overview' };
    }
    buildGroupSections();
    buildCards();
    buildCommands();
    markDirty();
  });
  es.addEventListener('items', (e) => {
    let failed = 0;
    for (const item of JSON.parse(e.data)) {
      const before = state.items.get(item.id);
      state.items.set(item.id, item);
      if (['deleted', 'gone', 'missing'].includes(item.status)) state.selection.delete(item.id);
      if (item.status === 'error' && item.error && before?.status !== 'error') failed++;
      // a run is finished once nothing is queued or mid-delete any more
      if (state.run && ['deleted', 'gone', 'error', 'missing'].includes(item.status) && state.run.ids.has(item.id)) {
        state.run.pending.delete(item.id);
        if (item.status === 'deleted') {
          state.run.done++;
          // per-run bytes: the server's counters are session-wide, so a second
          // clean would otherwise report the first one's total again
          state.run.bytes += item.bytes || 0;
        } else if (item.status === 'error') state.run.failed++;
      }
    }
    // one message per batch: a failed bulk clean used to fire a toast per row
    if (failed) toast(`${fmtCount(failed)} item${failed === 1 ? '' : 's'} could not be removed — see the ⚠ rows.`, true);
    if (state.run && state.run.pending.size === 0) finishRun();
    markDirty();
  });
  es.addEventListener('progress', (e) => { applyScanState(JSON.parse(e.data)); markDirty(); });
  es.addEventListener('scan', (e) => {
    const s = JSON.parse(e.data);
    if (state.scan.status === 'scanning' && s.status === 'done') state.scanEndedAt = Date.now();
    applyScanState(s);
    markDirty();
  });
  es.addEventListener('walk', (e) => { $('#walk-dir').textContent = 'scanning ' + JSON.parse(e.data).dir; });
  // another window changed a preference — follow it
  es.addEventListener('settings', (e) => {
    const s = JSON.parse(e.data);
    const wasMode = state.uiMode;
    applySettings(s);
    if (state.uiMode !== wasMode) { buildGroupSections(); buildCards(); }
    renderModeToggles();
    markDirty();
  });
  es.addEventListener('disk', (e) => { state.disk = JSON.parse(e.data); markDirty(); });
  es.addEventListener('reclaimed', (e) => {
    const r = JSON.parse(e.data);
    state.reclaimed = r.bytes;
    state.trashed = r.trashed || 0;
    markDirty();
  });
  es.addEventListener('fda', (e) => {
    const granted = JSON.parse(e.data).granted;
    const was = state.fda;
    state.fda = granted;
    // keep the card up briefly so the user sees the pill flip green
    if (granted && was === false) {
      state.fdaJustGranted = Date.now();
      setTimeout(markDirty, 4500);
    }
    markDirty();
  });
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
  for (const g of activeGroups()) {
    const section = document.createElement('div');
    section.className = 'group';
    section.hidden = true;
    section.innerHTML = `
      <div class="group-header">
        <input type="checkbox" title="Select group" aria-label="Select all in ${g.title}">
        <span class="g-icon">${g.icon}</span>
        <span class="g-title">${g.title}</span>
        <span class="g-count"></span>
        <span class="g-hidden"></span>
        <span class="g-safety"></span>
        <span class="g-size"></span>
      </div>
      <div class="group-body"></div>`;
    section.querySelector('.g-hidden').addEventListener('click', () => {
      if (activeFilterLabels().length) clearFilters();
    });
    const check = section.querySelector('input');
    check.addEventListener('change', () => {
      // operate on ALL selectable items of the group (not just filtered-visible
      // ones) so the checkbox always reflects what would actually be deleted
      const all = [...state.items.values()].filter(i => groupOf(i) === g.id);
      // …and honour the same rule the sub-headers use, so ticking a whole
      // duplicates category still leaves one copy of every set behind
      const rule = clusterRuleFor(g.id, all);
      for (const i of all) {
        if (!clusterSelectable(i, rule)) continue;
        check.checked ? state.selection.add(i.id) : state.selection.delete(i.id);
      }
      markDirty();
    });
    container.appendChild(section);
    groupEls.set(g.id, {
      section,
      body: section.querySelector('.group-body'),
      count: section.querySelector('.g-count'),
      hidden: section.querySelector('.g-hidden'),
      safety: section.querySelector('.g-safety'),
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

// A new scan session means the previous session's items no longer exist. Their
// ids are never reused, so keeping them doubled every total, left dead rows
// selectable, and made "Clean" report that nothing was removed.
function applyScanState(s) {
  if (s.session !== undefined && state.scan.session !== undefined && s.session !== state.scan.session) {
    state.items = new Map();
    state.selection.clear();
    state.receipt = null;
    state.run = null;
  }
  state.scan = s;
}

function selectable(i) {
  return !i.displayOnly && !isKept(i)
    && !['deleted', 'gone', 'missing', 'deleting', 'queued'].includes(i.status);
}

// Two rules, used everywhere a number is produced, so no two places disagree.
//   countable   — these bytes exist on disk and are counted exactly once
//                 (noTotal rows live inside another row that already counts them)
//   reclaimable — of those, the ones a click can actually free. Read-only rows
//                 are shown to explain where space went; adding them to a
//                 "you can free up" figure is a lie, and on a Mac with a Photos
//                 library it is a 100 GB lie.
function countable(i) {
  return !['deleted', 'gone', 'missing'].includes(i.status) && !i.noTotal && !isKept(i);
}

function reclaimable(i) {
  return countable(i) && !i.displayOnly;
}

// Bytes a selection would actually free: a child inside an already-selected
// folder is not counted twice.
// Bytes a selection would actually free, split by safety.
// Keyed on the real path, not the display string: "~/Library/Mail" is a string
// prefix of "~/Library/Mail Downloads" without being its parent, and several
// rows can legitimately share one display (an emulator lists its snapshots,
// its user data and the whole device).
//
// Single sorted sweep instead of a per-item scan over all roots: the naive
// version measured 90–96 ms per call with "Select all safe" ticked (1,100+
// items) and ran at 4 Hz — a frozen UI on the mode's flagship button. Sorting
// with '/' forced below every other byte makes each directory's descendants
// contiguous, so one ancestor stack replaces the O(n²) prefix scans (~0.5 ms).
function selectionTotals(items) {
  const seen = new Set();
  const list = [];
  for (const i of items) {
    const abs = i.abs || i.display;
    const key = abs + '|' + i.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ abs, sortKey: abs.replaceAll('/', '\u0000'), i });
  }
  // directories before file-lists at the same path, so the dir claims the root
  list.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1
    : (a.i.kind === 'files' ? 1 : 0) - (b.i.kind === 'files' ? 1 : 0));
  const by = { safe: 0, caution: 0, risky: 0 };
  let bytes = 0;
  const roots = [];
  for (const { abs, i } of list) {
    const probe = abs + '/';
    while (roots.length && !probe.startsWith(roots[roots.length - 1])) roots.pop();
    if (roots.length) continue;                     // freed by a selected ancestor
    bytes += i.bytes;
    by[i.safety] += i.bytes;
    if (i.kind !== 'files') roots.push(probe);      // file-lists don't free their parent dir
  }
  return { bytes, by };
}

const selectionBytes = (items) => selectionTotals(items).bytes;

function passesFilters(i) {
  if (['missing'].includes(i.status)) return false;
  if (isKept(i)) return false;
  // "show me only what failed" — everything else is irrelevant in that mode
  if (state.filters.errorsOnly) return i.status === 'error';
  if (state.filters.safety && i.safety !== state.filters.safety) return false;
  if (i.bytes < state.filters.minBytes && i.status !== 'scanning' && i.status !== 'denied') return false;
  if (state.filters.q) {
    const q = state.filters.q.toLowerCase();
    // also match what the row actually shows: normal mode strips bundle ids
    // from the name and puts the explanation where the path used to be, so
    // searching for the words on screen has to work
    const hay = [i.name, i.display, displayName(i), state.uiMode === 'normal' ? i.why : ''];
    if (!hay.some(h => h && h.toLowerCase().includes(q))) return false;
  }
  return true;
}

function visibleItems() {
  return [...state.items.values()].filter(passesFilters);
}

// A group reading "0 items (3 filtered out)" is baffling when the filter that
// hid them (a safety tile, the size dropdown) is scrolled out of view — so the
// active filters are always spelled out, and one click clears them.
function activeFilterLabels() {
  const out = [];
  if (state.filters.safety) out.push(state.filters.safety);
  if (state.filters.minBytes > 0) out.push('≥ ' + fmtBytes(state.filters.minBytes));
  if (state.filters.q) out.push(`“${state.filters.q}”`);
  if (state.filters.errorsOnly) out.push('failed items only');
  return out;
}

function clearFilters() {
  state.filters.safety = null;
  state.filters.errorsOnly = false;
  state.filters.minBytes = 0;
  state.filters.q = '';
  $('#search').value = '';
  $('#min-size').value = '0';
  markDirty();
}

function renderFilterChip() {
  const chip = $('#clear-filters');
  const labels = activeFilterLabels();
  const hidden = [...state.items.values()]
    .filter(i => i.status !== 'missing' && !isKept(i) && !passesFilters(i)).length;
  chip.hidden = !labels.length || hidden === 0;
  if (!chip.hidden) {
    chip.textContent = `${fmtCount(hidden)} hidden by: ${labels.join(' · ')} — clear ✕`;
    chip.title = 'Clear the size, safety and text filters';
  }

  // kept items are a deliberate choice, not a filter — its own chip, and the
  // only way back, so "keep" never becomes a one-way door
  const kept = $('#kept-chip');
  const keptCount = [...state.items.values()].filter(isKept).length;
  kept.hidden = keptCount === 0;
  if (keptCount) {
    kept.textContent = `📌 ${fmtCount(keptCount)} kept — show again`;
    kept.title = 'Stop hiding the items you chose to keep';
  }
}

// ------------------------------------------------------------- render -----

setInterval(() => { if (dirty) { dirty = false; render(); } }, 250);

function render() {
  renderHeader();
  renderSummary();
  renderReceipt();
  if (state.view.name === 'group') renderDetail();
  else if (state.view.name === 'settings') renderSettings();
  else renderCards();
  renderSelectionBar();
}

function renderSettings() {
  renderModeToggles();
  const pill = $('#settings-fda-pill');
  if (state.fda === false) { pill.className = 'fda-pill waiting'; pill.textContent = 'not granted'; }
  else { pill.className = 'fda-pill granted'; pill.textContent = '✓ granted'; }
  $('#settings-fda-target').textContent = state.appMode ? 'Mac Cleaner' : 'your terminal app (Terminal, iTerm, …)';
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

  // Bytes moved to the Trash are not freed yet — labelling them "reclaimed"
  // is a promise the Trash has not kept.
  const rec = $('#reclaimed');
  if (state.trashed > 0 && state.reclaimed === 0) {
    rec.textContent = '🗑️ ' + fmtBytes(state.trashed) + ' in Trash';
    rec.title = 'Moved to the Trash — emptying it is what frees the space';
  } else if (state.trashed > 0) {
    rec.textContent = '♻️ ' + fmtBytes(state.reclaimed) + ' · 🗑️ ' + fmtBytes(state.trashed);
    rec.title = 'Freed permanently · waiting in the Trash';
  } else {
    rec.textContent = '♻️ ' + fmtBytes(state.reclaimed);
    rec.title = 'Space freed this session';
  }

  if (state.disk) {
    const used = state.disk.total - state.disk.free;
    const usedPct = used / state.disk.total * 100;
    let cleanable = 0;
    for (const i of state.items.values()) {
      if ((i.status === 'done' || i.status === 'scanning') && reclaimable(i)) cleanable += i.bytes;
    }
    const cleanPct = Math.min(cleanable / state.disk.total * 100, usedPct);
    $('#disk-used').style.width = usedPct + '%';
    const cl = $('#disk-clean');
    cl.style.left = (usedPct - cleanPct) + '%';
    cl.style.width = cleanPct + '%';
    $('#disk-label').textContent =
      `${fmtBytes(used)} used · ${fmtBytes(state.disk.free)} free · ${fmtBytes(cleanable)} cleanable found`;
  }

  const hasItems = state.items.size > 0;
  const settingsView = state.view.name === 'settings';
  const overview = state.view.name === 'overview';
  const normal = state.uiMode === 'normal';
  $('#hero').hidden = hasItems || status === 'scanning' || settingsView;
  $('#summary').hidden = !hasItems || !overview;
  $('#controls').hidden = !hasItems || settingsView;
  // terminal commands are developer territory — never shown in normal mode
  $('#commands').hidden = !hasItems || !overview || normal;
  $('#cards').hidden = !hasItems || !overview;
  $('#detail').hidden = overview || settingsView;
  $('#settings').hidden = !settingsView;

  if (state.scanEndedAt && status === 'done') {
    const min = Math.round((Date.now() - state.scanEndedAt) / 60000);
    $('#scan-meta').textContent = `${fmtCount(state.items.size)} items · scanned ${min < 1 ? 'just now' : min + ' min ago'}`;
  } else if (status === 'done') {
    $('#scan-meta').textContent = `${fmtCount(state.items.size)} items`;
  } else {
    $('#scan-meta').textContent = '';
  }

  renderFda();
}

function renderFda() {
  // only rows that Full Disk Access could actually unlock — root-owned denials
  // are not the user's to fix and must not drive this UI
  let blocked = 0;
  let blockedBytesUnknown = 0;
  for (const i of state.items.values()) {
    if (i.needs === 'fda' && (state.fda === false || i.status === 'denied')) {
      blocked++;
      if (!i.bytes) blockedBytesUnknown++;
    }
  }
  const missing = state.fda === false;
  const justGranted = state.fdaJustGranted && Date.now() - state.fdaJustGranted < 4500;
  const showCard = (missing || justGranted) && !state.fdaDismissed;
  $('#fda-card').hidden = !showCard;
  // Only claim access is missing when it actually is. Root-owned paths deny
  // reads no matter what the user grants, so counting them made the lock (and
  // its "grant access" promise) appear on a Mac where FDA was already on.
  $('#fda-lock').hidden = !missing;
  if (!showCard) return;

  $('#fda-target').textContent = state.appMode ? 'Mac Cleaner' : 'your terminal app (Terminal, iTerm, …)';
  const pill = $('#fda-pill');
  const hint = $('#fda-hint');
  const relaunch = $('#fda-relaunch');
  const canRelaunch = state.appMode && !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.relaunch);
  if (missing) {
    pill.className = 'fda-pill waiting';
    pill.innerHTML = '<span class="spinner"></span> waiting for permission…';
    // say what is actually locked, in items, rather than a vague warning
    if (blocked) {
      $('#fda-why').textContent = `${fmtCount(blocked)} place${blocked === 1 ? '' : 's'} on your disk `
        + `(Mail, Messages, your Photos library, iPhone backups…) cannot be measured yet — `
        + `${blockedBytesUnknown ? 'they currently show as 0 B' : 'their sizes are incomplete'}. `
        + 'macOS never asks for this permission on its own; you turn it on, it applies when the app restarts.';
    }
    relaunch.hidden = true;
    hint.textContent = state.appMode
      ? 'macOS only applies the permission when the app starts again.'
      : 'Then restart ./run.sh in your terminal and rescan.';
  } else {
    pill.className = 'fda-pill granted';
    pill.textContent = '✓ Full Disk Access granted';
    // the grant is only live for a process started AFTER it was given
    relaunch.hidden = !canRelaunch;
    hint.textContent = canRelaunch
      ? 'One restart and the locked places become visible.'
      : state.appMode ? 'Quit and reopen Mac Cleaner, then rescan.'
        : 'Restart ./run.sh in your terminal, then rescan.';
  }
}

function renderSummary() {
  const totals = { all: 0, safe: 0, caution: 0, risky: 0 };
  const byGroup = new Map();
  let readOnlyBytes = 0;
  let readOnlyTop = null;
  for (const i of state.items.values()) {
    if (!countable(i)) continue;
    if (i.displayOnly) {
      readOnlyBytes += i.bytes;
      if (!readOnlyTop || i.bytes > readOnlyTop.bytes) readOnlyTop = i;
      continue;
    }
    totals.all += i.bytes;
    totals[i.safety] += i.bytes;
    const gid = groupOf(i);
    byGroup.set(gid, (byGroup.get(gid) || 0) + i.bytes);
  }
  $('#tile-total .tile-value').textContent = fmtBytes(totals.all);
  $('#tile-total .tile-label').textContent =
    state.uiMode === 'normal' ? 'you can free up' : 'cleanable found';

  // Space that is real but not yours to click away (Photos library, Time
  // Machine snapshots, macOS-managed caches). Kept out of the headline and
  // stated plainly instead, so the two numbers never contradict each other.
  const roNote = $('#readonly-note');
  if (readOnlyBytes > 0) {
    roNote.hidden = false;
    const biggest = readOnlyTop && readOnlyTop.bytes > readOnlyBytes / 3
      ? ` — mostly ${readOnlyTop.name} (${fmtBytes(readOnlyTop.bytes)})` : '';
    roNote.textContent = `+ ${fmtBytes(readOnlyBytes)} that macOS and your apps manage themselves${biggest}. Shown so you can see where the space went; this tool never deletes it.`;
  } else {
    roNote.hidden = true;
  }

  // live label: what "Select all safe" would actually grab (same exclusions),
  // plus WHY the rest of the safe total is not in it — the two numbers looking
  // unrelated is otherwise the most confusing thing on the screen
  let bulkSafe = 0;
  const skipped = { active: 0, trash: 0, other: 0 };
  for (const i of state.items.values()) {
    if (i.safety !== 'safe' || !reclaimable(i)) continue;
    if (!selectable(i)) { skipped.other += i.bytes; continue; }
    if (i.permanentOnly) { skipped.trash += i.bytes; continue; }
    if ((i.badges || []).includes('active project')) { skipped.active += i.bytes; continue; }
    bulkSafe += i.bytes;
  }
  $('#select-safe').textContent = bulkSafe > 0 ? `Select all safe (${fmtBytes(bulkSafe)})` : 'Select all safe';

  const reasons = [];
  if (skipped.active > 0) reasons.push(`${fmtBytes(skipped.active)} in active projects`);
  if (skipped.trash > 0) reasons.push(`${fmtBytes(skipped.trash)} in Trash (permanent)`);
  if (skipped.other > 0) reasons.push(`${fmtBytes(skipped.other)} read-only`);
  const sub = $('#safe-sub');
  sub.textContent = reasons.length
    ? `${fmtBytes(bulkSafe)} in one click — ${reasons.join(', ')} must be picked by hand`
    : '';
  $('#select-safe').title = reasons.length
    ? `Skips ${reasons.join(', ')}. Select those items individually if you want them.`
    : 'Select every item classified safe';
  renderFilterChip();

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
    const g = activeGroups().find(x => x.id === s.gid);
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
    const gid = groupOf(i);
    if (!allByGroup.has(gid)) allByGroup.set(gid, []);
    allByGroup.get(gid).push(i);
    if (passesFilters(i)) {
      if (!visByGroup.has(gid)) visByGroup.set(gid, []);
      visByGroup.get(gid).push(i);
    }
  }

  for (const g of activeGroups()) {
    const els = groupEls.get(g.id);
    if (!els) continue;
    // detail view shows exactly one group; the rest stay hidden and unrendered
    if (g.id !== state.view.id) { els.section.hidden = true; continue; }
    const all = allByGroup.get(g.id) || [];
    const vis = sortItems(visByGroup.get(g.id) || []);
    els.section.hidden = false;

    const totalBytes = all.reduce((s, i) => countable(i) ? s + i.bytes : s, 0);
    els.size.textContent = fmtBytes(totalBytes);

    const bySafety = { safe: 0, caution: 0, risky: 0 };
    for (const i of all) if (countable(i)) bySafety[i.safety] += i.bytes;
    els.safety.innerHTML = ['safe', 'caution', 'risky']
      .filter(s => bySafety[s] > 0)
      .map(s => `<span class="gs gs-${s}"><span class="dot dot-${s}"></span>${fmtBytes(bySafety[s])}</span>`)
      .join('');
    els.count.textContent = `${fmtCount(vis.length)} item${vis.length === 1 ? '' : 's'}`;
    const hiddenCount = all.length - vis.length;
    // clickable: the filter that hid them is often scrolled off-screen
    els.hidden.textContent = hiddenCount > 0
      ? `(${fmtCount(hiddenCount)} filtered out — show)` : '';
    els.hidden.classList.toggle('clickable', hiddenCount > 0);
    els.hidden.title = hiddenCount > 0 ? `Hidden by: ${activeFilterLabels().join(' · ')}. Click to clear filters.` : '';

    // must match exactly what the header checkbox selects — including the
    // duplicate keeper it deliberately leaves alone
    const headerRule = clusterRuleFor(g.id, all);
    const selectableAll = all.filter(i => clusterSelectable(i, headerRule));
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

    const cluster = clusterRuleFor(g.id, all);
    if (cluster) {
      // cluster by key (project dir / duplicate set / original category)
      const byKey = new Map();
      for (const item of vis) {
        const key = cluster.key(item);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(item);
      }
      const clusters = [...byKey.entries()]
        .map(([proj, items]) => ({ proj, items, gid: g.id, rule: cluster, total: items.reduce((s, i) => countable(i) ? s + i.bytes : s, 0) }))
        .sort((a, b) => b.total - a.total);
      for (const c of clusters) {
        const phId = 'ph:' + g.id + ':' + c.proj;
        seen.add(phId);
        let ph = rowEls.get(phId);
        if (!ph) { ph = buildProjectHeader(phId, c.proj, g.id, cluster); rowEls.set(phId, ph); }
        updateProjectHeader(ph, c);
        place(ph);
        for (const item of sortItems(c.items)) {
          seen.add(item.id);
          let row = rowEls.get(item.id);
          if (!row) { row = buildRow(item); rowEls.set(item.id, row); }
          updateRow(row, item, true);
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

// Groups whose rows are broken into sub-headers. `key` groups the items,
// `icon`/`noun` label the header, `aria`/`title` describe its checkbox.
// The developer card in normal mode is the reason this is a rule and not a
// boolean: hundreds of technical items are only browsable when split back
// into the categories they came from.
function clusterRuleFor(gid, items) {
  const byProject = (i) => i.project || '(other)';
  if (gid === 'projects') {
    return { key: byProject, icon: () => '📁', noun: ['artifact', 'artifacts'],
      aria: 'Select all artifacts of this project', title: 'Select group' };
  }
  if (gid === 'duplicates' || gid === 'n-dups') {
    // group on the content hash, never on the header label: the label rounds
    // sizes, so two unrelated sets of same-named files can print identically
    return { key: (i) => i.dupSet || byProject(i), label: byProject,
      icon: () => '👯', noun: ['copy', 'copies'], skipKeeper: true, thumb: true,
      aria: 'Select all copies except the suggested keeper', title: 'Selects every copy except the one suggested to keep' };
  }
  // A normal-mode category can merge several technical ones — "System Junk"
  // alone can hold a thousand rows. Once it does, split it back into the
  // categories the items came from, so it stays navigable.
  if (state.uiMode === 'normal' && items.length > 12) {
    const sources = new Set(items.map(i => i.group));
    if (sources.size > 1) {
      return {
        key: (i) => (state.groups.find(g => g.id === i.group) || {}).title || 'Other',
        icon: (name) => (state.groups.find(g => g.title === name) || {}).icon || '📂',
        noun: ['item', 'items'], aria: 'Select everything in this category', title: 'Select category',
      };
    }
  }
  return null;
}

// duplicates: the cluster checkbox intentionally skips the copy the scan
// suggests keeping, so "tick the set" reclaims space while always keeping one
const clusterSelectable = (i, rule) => selectable(i) && !(rule?.skipKeeper && i.dupKeep);

// Floating larger preview for a duplicate set — click the thumbnail to open,
// click anywhere (or Escape) to close.
function showThumbPreview(item, anchor) {
  const box = $('#thumb-preview');
  box.querySelector('img').src = `/api/thumb?id=${encodeURIComponent(item.id)}&t=${TOKEN}&s=512`;
  box.querySelector('.tp-name').textContent = displayName(item);
  box.querySelector('.tp-path').textContent = item.display;
  box.hidden = false;
  const r = anchor.getBoundingClientRect();
  box.style.top = Math.min(window.innerHeight - 380, r.bottom + 8) + 'px';
  box.style.left = Math.min(window.innerWidth - 360, Math.max(8, r.left)) + 'px';
  const close = () => { box.hidden = true; document.removeEventListener('click', close, true); };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

// Every item of the cluster, filters ignored on purpose: a checkbox must act
// on what it says it acts on. Filters hide rows; they never silently shrink a
// bulk action (the "N filtered out — show" line already discloses the gap).
function clusterItems(gid, proj, rule) {
  return [...state.items.values()].filter(i =>
    i.status !== 'missing' && groupOf(i) === gid && rule.key(i) === proj);
}

function buildProjectHeader(phId, proj, gid, rule) {
  const el = document.createElement('div');
  el.className = 'prow-header';
  el.dataset.id = phId;
  el.innerHTML = `
    <input type="checkbox">
    <span class="ph-icon"></span>
    <span class="ph-name"></span>
    <span class="ph-count"></span>
    <span class="ph-size"></span>`;
  el.querySelector('.ph-icon').textContent = rule.icon(proj);
  // the key can be a content hash — show the human label when the rule has one
  const first = [...state.items.values()].find(i => groupOf(i) === gid && rule.key(i) === proj);
  el.querySelector('.ph-name').textContent = (rule.label && first) ? rule.label(first) : proj;
  // A duplicate set of photos or videos is decided with the eyes, not the
  // name: a Quick Look thumbnail in the header, click for a bigger look.
  if (rule.thumb && first) {
    const img = document.createElement('img');
    img.className = 'ph-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/thumb?id=${encodeURIComponent(first.id)}&t=${TOKEN}`;
    img.addEventListener('error', () => img.remove()); // no preview → icon only
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      showThumbPreview(first, img);
    });
    img.title = 'Click for a bigger preview';
    el.insertBefore(img, el.querySelector('.ph-name'));
  }
  const check = el.querySelector('input');
  check.setAttribute('aria-label', rule.aria);
  check.title = rule.title;
  check.addEventListener('change', (e) => {
    for (const i of clusterItems(gid, proj, rule)) {
      if (!clusterSelectable(i, rule)) continue;
      e.target.checked ? state.selection.add(i.id) : state.selection.delete(i.id);
    }
    markDirty();
  });
  return el;
}

function updateProjectHeader(ph, c) {
  const [one, many] = c.rule.noun;
  ph.querySelector('.ph-size').textContent = fmtBytes(c.total);
  // duplicates: the number that matters is what deleting the extras frees —
  // the total says how much the set occupies, not what the user gains
  if (c.rule.skipKeeper) {
    const keeper = c.items.reduce((m, i) => (i.dupKeep ? i : m), null);
    const waste = Math.max(0, c.total - (keeper ? keeper.bytes : (c.items[0]?.bytes || 0)));
    ph.querySelector('.ph-count').textContent =
      `${fmtCount(c.items.length)} ${c.items.length === 1 ? one : many} · frees ${fmtBytes(waste)} keeping one`;
  } else {
    ph.querySelector('.ph-count').textContent =
      `${fmtCount(c.items.length)} ${c.items.length === 1 ? one : many}`;
  }
  // state is computed over everything the checkbox would touch, not just the
  // rows currently visible — otherwise it renders indeterminate forever
  const selectableItems = clusterItems(c.gid, c.proj, c.rule).filter(i => clusterSelectable(i, c.rule));
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
      <div class="r-loc" title="Show this file in its folder in Finder"></div>
      <div class="r-note" hidden></div>
    </div>
    <div class="r-status"></div>
    <div class="r-size"></div>
    <div class="r-actions">
      <button class="icon-btn act-keep" title="Keep this — hide it from future scans">📌</button>
      <button class="icon-btn act-reveal" title="Show in Finder — opens the folder with this item selected">📂</button>
      <button class="icon-btn act-delete" title="Delete this item">🗑️</button>
    </div>`;
  row.querySelector('.act-keep').addEventListener('click', () => keepItem(item.id));
  // the path itself is a way to the file, not just a label
  row.querySelector('.r-loc').addEventListener('click', () => post('/api/reveal', { id: item.id }).catch(e => toast(e.message, true)));
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

function updateRow(row, item, indent) {
  // one assignment with every modifier included: writing the class twice per
  // render (here, then .classList.add('row-indent') in the caller) restyled
  // every row on every tick
  const cls = 'row status-' + item.status + (item.displayOnly ? ' display-only' : '') + (indent ? ' row-indent' : '');
  if (row.className !== cls) row.className = cls;
  const check = row.querySelector('input');
  check.checked = state.selection.has(item.id);
  check.disabled = !selectable(item);

  const nameEl = row.querySelector('.r-name');
  const label = displayName(item);
  // state.fda and status feed the badges now, so they must invalidate the cache
  const badgeSig = [item.safety, item.needs || '', state.uiMode, state.fda, item.status, ...(item.badges || [])].join('|');
  if (row.dataset.badgeSig !== badgeSig || nameEl.querySelector('.nm').textContent !== label) {
    row.dataset.badgeSig = badgeSig;
    nameEl.innerHTML = '<span class="nm"></span>';
    nameEl.querySelector('.nm').textContent = label;
    const sb = document.createElement('span');
    sb.className = 'badge badge-safety-' + item.safety;
    sb.textContent = item.safety;
    nameEl.appendChild(sb);
    // "needs Full Disk Access" is only true while it is missing — once granted
    // the row is measured, and the badge became 58 lies in a row
    if (item.needs === 'root' || (item.needs === 'fda' && (state.fda === false || item.status === 'denied'))) {
      const nb = document.createElement('span');
      nb.className = 'badge badge-needs';
      nb.textContent = item.needs === 'fda' ? 'needs Full Disk Access' : 'managed by macOS';
      nameEl.appendChild(nb);
    }
    for (const b of item.badges || []) {
      const el = document.createElement('span');
      el.className = 'badge badge-info';
      el.textContent = b;
      nameEl.appendChild(el);
    }
  }
  // outside the badge guard: why/regen change after a scan (backup labels,
  // carve-outs), and a tooltip frozen at first render would then be wrong
  const title = (item.why || '') + (item.regen ? '\n↩ ' + item.regen : '');
  if (row.title !== title) row.title = title;

  // A row nobody can act on must say what the user CAN do, on screen — a
  // hover tooltip is invisible on a trackpad-less glance and unreachable on
  // touch, and in normal mode the fallback advice ("see suggested commands")
  // pointed at a section that mode hides.
  const note = row.querySelector('.r-note');
  const needsNote = item.displayOnly || item.needs;
  const noteText = !needsNote ? ''
    : item.needs === 'fda' && state.fda === false
      ? 'Needs Full Disk Access before its real size can be measured — grant it above, then rescan.'
      : (item.regen || '');
  if (note.textContent !== noteText) note.textContent = noteText;
  note.hidden = !noteText;
  // Normal mode answers "what is this?" on the second line — and the path is
  // ALWAYS shown on its own line underneath, clickable to open the file's
  // folder in Finder. Hiding the location bred distrust: users want to see
  // exactly which folder and file a row is talking about before touching it.
  const age = item.mtime ? '  ·  ' + fmtAge(item.mtime) : '';
  const loc = row.querySelector('.r-loc');
  if (state.uiMode === 'normal') {
    row.querySelector('.r-path').textContent = (item.why || '') + age;
    loc.hidden = false;
    // LRM marks pin the leading "~/" in place: the element renders RTL so a
    // long path truncates at the START and keeps the file name visible
    const shown = '‎' + item.display + '‎';
    if (loc.textContent !== shown) loc.textContent = shown;
  } else {
    row.querySelector('.r-path').textContent = item.display + age;
    loc.hidden = true;
  }

  const statusEl = row.querySelector('.r-status');
  if (item.status === 'scanning') statusEl.innerHTML = '<span class="spinner"></span>';
  else if (item.status === 'queued') statusEl.textContent = 'queued…';
  else if (item.status === 'deleting') statusEl.innerHTML = '<span class="spinner"></span> deleting';
  else if (item.status === 'deleted') statusEl.textContent = 'deleted ✓';
  else if (item.status === 'gone') statusEl.textContent = 'removed';
  else if (item.status === 'denied') statusEl.textContent = '🔒 no access';
  else if (item.status === 'error') statusEl.textContent = '⚠ ' + (item.error || 'failed');
  else if (item.displayOnly) statusEl.textContent = 'read-only';
  else statusEl.textContent = item.files ? fmtCount(item.files) + (item.files === 1 ? ' file' : ' files') : '';

  row.querySelector('.r-size').textContent = fmtBytes(item.bytes);
}

function renderSelectionBar() {
  const ids = [...state.selection].filter(id => { const i = state.items.get(id); return i && selectable(i); });
  const bar = $('#selection-bar');
  bar.hidden = ids.length === 0;
  if (ids.length) {
    const items = ids.map(id => state.items.get(id));
    // one pass for both figures — chips summed separately used to exceed the
    // total sitting next to them
    const { bytes, by } = selectionTotals(items);
    $('#sel-count').textContent = fmtCount(ids.length);
    $('#sel-size').textContent = fmtBytes(bytes);
    $('#sel-breakdown').innerHTML = ['safe', 'caution', 'risky']
      .filter(s => by[s] > 0)
      .map(s => `<span class="gs gs-${s}"><span class="dot dot-${s}"></span>${fmtBytes(by[s])}</span>`)
      .join('');
    // pure-safe selection = quiet; anything caution/risky = visible warning tint
    bar.classList.toggle('has-caution', by.caution > 0 && by.risky === 0);
    bar.classList.toggle('has-risky', by.risky > 0);
  }
}

// ------------------------------------------------------------- cards ------

const cardEls = new Map();   // groupId -> {el, size, meta, bar: {safe, caution, risky}}

function buildCards() {
  const wrap = $('#cards');
  wrap.innerHTML = '';
  cardEls.clear();
  for (const g of activeGroups()) {
    const el = document.createElement('button');
    el.className = 'card' + (g.id === 'n-dev' ? ' card-advanced' : '');
    el.setAttribute('aria-label', 'Open ' + g.title);
    el.style.setProperty('--card-accent', groupColor.get(g.id) || 'var(--c-other)');
    el.innerHTML = `
      <div class="card-top">
        <span class="card-icon">${g.icon}</span>
        <span class="card-title">${g.title}</span>
        <span class="card-chevron">›</span>
      </div>
      <div class="card-size">—</div>
      <div class="card-desc"></div>
      <div class="card-meta"></div>
      <div class="card-bar">
        <div class="cb-safe"></div><div class="cb-caution"></div><div class="cb-risky"></div>
      </div>`;
    el.addEventListener('click', () => { if (!el.classList.contains('card-empty')) openGroup(g.id); });
    // description only exists in the normal taxonomy; CSS hides it in dev mode
    el.querySelector('.card-desc').textContent = g.desc || '';
    wrap.appendChild(el);
    cardEls.set(g.id, {
      el,
      size: el.querySelector('.card-size'),
      meta: el.querySelector('.card-meta'),
      bar: {
        safe: el.querySelector('.cb-safe'),
        caution: el.querySelector('.cb-caution'),
        risky: el.querySelector('.cb-risky'),
      },
    });
  }
}

function renderCards() {
  const stats = new Map();
  for (const i of state.items.values()) {
    // same rules as everywhere else: a kept row must vanish from the card too,
    // or the card and the detail header it opens report different numbers
    if (['deleted', 'gone', 'missing'].includes(i.status) || isKept(i)) continue;
    const gid = groupOf(i);
    const s = stats.get(gid)
      || { n: 0, b: 0, safe: 0, caution: 0, risky: 0, ro: 0, denied: 0, scanning: 0, match: false };
    s.n++;
    if (countable(i)) { s.b += i.bytes; s[i.safety] += i.bytes; }
    if (i.displayOnly) s.ro++;
    if (i.status === 'denied') s.denied++;
    if (i.status === 'scanning') s.scanning++;
    if (i.status === 'error') s.failed = (s.failed || 0) + 1;
    if (i.group === 'duplicates') (s.sets ??= new Set()).add(i.dupSet || i.project || '');
    // the same test the rows use, so a search that matches 109 rows cannot
    // leave every card dimmed as though nothing matched
    if (state.filters.q && passesFilters(i)) s.match = true;
    stats.set(gid, s);
  }
  const q = state.filters.q.toLowerCase();
  for (const g of activeGroups()) {
    const c = cardEls.get(g.id);
    if (!c) continue;
    const s = stats.get(g.id);
    const empty = !s;
    c.el.classList.toggle('card-empty', empty);
    c.el.disabled = empty;
    if (empty) {
      c.size.textContent = '—';
      // duplicates and unused apps register in a late phase — declaring
      // "nothing found" while the scan is still running is simply untrue
      c.meta.textContent = state.scan.status === 'scanning' ? 'still looking…' : 'nothing found';
      for (const k of ['safe', 'caution', 'risky']) c.bar[k].style.width = '0%';
    } else {
      c.size.textContent = fmtBytes(s.b);
      const bits = [`${fmtCount(s.n)} item${s.n === 1 ? '' : 's'}`];
      if (s.sets) bits.push(`${fmtCount(s.sets.size)} set${s.sets.size === 1 ? '' : 's'}`);
      if (s.scanning) bits.push('scanning…');
      if (s.ro) bits.push(`${fmtCount(s.ro)} read-only`);
      if (s.denied) bits.push(`🔒 ${fmtCount(s.denied)}`);
      if (s.failed) bits.push(`⚠ ${fmtCount(s.failed)} failed`);
      c.meta.textContent = bits.join(' · ');
      const tot = s.b || 1;
      for (const k of ['safe', 'caution', 'risky']) c.bar[k].style.width = (s[k] / tot * 100) + '%';
    }
    // overview search: spotlight cards whose title or contents match
    const titleMatch = q && g.title.toLowerCase().includes(q);
    const match = q ? (titleMatch || (s && s.match)) : false;
    c.el.classList.toggle('card-match', !!match);
    c.el.classList.toggle('card-dim', !!q && !match);
  }
}

// ------------------------------------------------------------- detail -----

function renderDetail() {
  const g = activeGroups().find(x => x.id === state.view.id);
  // a link into the other mode's taxonomy (bookmark, back button, mode switch)
  // — showing the previous group instead would be a lie about what is listed
  if (!g) { closeGroup(); return; }
  $('#detail-title').textContent = `${g.icon} ${g.title}`;
  $('#detail-desc').textContent = g.desc || '';
  renderGroups();
}

function openGroup(id) { location.hash = '#g/' + encodeURIComponent(id); }
function closeGroup() { location.hash = ''; }

let transitioning = false;

function applyViewSwap(next) {
  const swap = () => {
    state.view = next;
    if (next.name !== 'overview') window.scrollTo({ top: 0 });
    render();
    const shown = $(next.name === 'group' ? '#detail' : next.name === 'settings' ? '#settings' : '#cards');
    shown.classList.remove('view-enter');
    void shown.offsetWidth;            // restart the enter animation
    shown.classList.add('view-enter');
  };
  // A transition started while another is running is aborted — and an aborted
  // transition may never run its callback, which would leave the old view on
  // screen with handlers that no longer match the current mode. Correctness
  // first: only animate when nothing else is animating.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced && !transitioning && document.startViewTransition) {
    transitioning = true;
    const t = document.startViewTransition(swap);
    // all three settle independently and all three reject on an abort
    t.ready.catch(() => {});
    t.updateCallbackDone.catch(() => {});
    t.finished.catch(() => {}).finally(() => { transitioning = false; });
  } else swap();
}

window.addEventListener('hashchange', () => applyViewSwap(viewFromHash()));

// ------------------------------------------------------------- modal ------

let modalIds = [];

function openModal(ids) {
  modalIds = ids.filter(id => { const i = state.items.get(id); return i && selectable(i); });
  if (!modalIds.length) return;
  const items = modalIds.map(id => state.items.get(id)).sort((a, b) => b.bytes - a.bytes);
  const risky = items.filter(i => i.safety === 'risky');
  const normal = items.filter(i => i.safety !== 'risky');
  const total = selectionBytes(items);
  // A duplicate set the user is about to wipe entirely: every copy selected,
  // none kept. Worth saying out loud, in the one dialog that can still stop it.
  // dupKeep is always serialized (as a boolean), so testing it for undefined
  // matched every row with a project — including build artifacts, which then
  // triggered a "duplicate set" warning about files that are not duplicates.
  const dupSets = new Map();
  for (const i of items) if (i.dupSet) dupSets.set(i.dupSet, (dupSets.get(i.dupSet) || 0) + 1);
  const wipedSets = [...dupSets].filter(([set, n]) =>
    n === [...state.items.values()].filter(x => x.dupSet === set && selectable(x)).length);

  const permanentOnly = items.filter(i => i.permanentOnly);
  let modeText = deleteMode() === 'trash'
    ? 'Items will be moved to Trash (restorable until you empty it).'
    : 'Items will be deleted permanently — this cannot be undone.';
  if (deleteMode() === 'trash' && permanentOnly.length) {
    modeText += ` ⚠️ ${permanentOnly.map(i => i.name).join(', ')}: always deleted permanently — cannot be restored.`;
  }
  $('#modal-mode').textContent = modeText;

  const fill = (el, list) => {
    el.innerHTML = '';
    for (const i of list.slice(0, 40)) {
      const r = document.createElement('div');
      r.className = 'm-row';
      r.innerHTML = `<span class="dot dot-${i.safety}"></span><span class="m-main"><span class="m-name"></span><span class="m-path"></span></span><span class="m-badges"></span><span class="m-size"></span>`;
      // name AND full path in both modes — the last look before deletion is
      // exactly where the user must see which file it really is
      r.querySelector('.m-name').textContent = state.uiMode === 'normal' ? displayName(i) : i.name;
      r.querySelector('.m-path').textContent = i.display;
      // badges carry the "newest — suggest keep" marker: hiding it here is how
      // a user deletes the copy they meant to keep without ever seeing a warning
      for (const b of i.badges || []) {
        const el = document.createElement('span');
        el.className = 'badge badge-info';
        el.textContent = b;
        r.querySelector('.m-badges').appendChild(el);
      }
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
  const warn = $('#modal-dup-warn');
  warn.hidden = wipedSets.length === 0;
  if (wipedSets.length) {
    warn.textContent = `⚠️ ${wipedSets.length} duplicate set${wipedSets.length === 1 ? '' : 's'} would lose every copy — no file is kept. Untick one copy per set to keep it.`;
  }
  $('#modal-total').textContent = `${fmtCount(items.length)} items — ${fmtBytes(total)}`;
  updateModalConfirm();
  $('#modal').hidden = false;
}

function updateModalConfirm() {
  const risky = modalIds.some(id => state.items.get(id)?.safety === 'risky');
  $('#modal-confirm').disabled = risky && !$('#risky-ack').checked;
  $('#modal-confirm').textContent = deleteMode() === 'trash' ? 'Move to Trash' : 'Delete permanently';
}

$('#risky-ack').addEventListener('change', updateModalConfirm);
$('#modal-cancel').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').hidden = true; });
$('#modal-confirm').addEventListener('click', async () => {
  $('#modal').hidden = true;
  // items may have changed state while the modal was open — re-filter
  modalIds = modalIds.filter(id => { const i = state.items.get(id); return i && selectable(i); });
  if (!modalIds.length) { toast('Nothing left to clean — items changed while confirming.'); return; }
  const mode = deleteMode();
  const plannedBytes = selectionBytes(modalIds.map(id => state.items.get(id)));
  try {
    const r = await post('/api/delete', { ids: modalIds, mode });
    const held = modalIds.length - r.accepted.length;
    if (!r.accepted.length) {
      toast('Nothing was removed — one copy of each duplicate set is always kept. Untick the copy you want to keep and select the others.', true);
      markDirty();
      return;
    }
    toast(`Cleaning ${r.accepted.length} item${r.accepted.length === 1 ? '' : 's'}…`
      + (held > 0 ? ` (${held} held back to keep one copy of each duplicate set)` : ''));
    // track this run so the user gets a plain answer when it ends, instead of
    // rows quietly changing status somewhere down the page
    state.run = { ids: new Set(r.accepted), pending: new Set(r.accepted), done: 0, failed: 0, bytes: 0, mode, plannedBytes };
    for (const id of modalIds) state.selection.delete(id);
    markDirty();
  } catch (e) { toast('Delete failed: ' + e.message, true); }
});

// ------------------------------------------------------------- receipt ----

function finishRun() {
  const run = state.run;
  state.run = null;
  if (!run || (run.done === 0 && run.failed === 0)) return;
  state.receipt = { ...run, at: Date.now() };
  markDirty();
}

function renderReceipt() {
  const r = state.receipt;
  const el = $('#receipt');
  el.hidden = !r || state.view.name === 'settings';
  if (!r) return;
  const moved = r.mode === 'trash';
  $('#receipt-title').textContent = moved
    ? `${fmtCount(r.done)} item${r.done === 1 ? '' : 's'} moved to the Trash`
    : `${fmtCount(r.done)} item${r.done === 1 ? '' : 's'} deleted — ${fmtBytes(r.bytes)} freed`;
  const bits = [];
  if (moved) bits.push(`${fmtBytes(r.bytes)} is in the Trash and still on your disk. Emptying the Trash is what actually frees it.`);
  if (r.failed) bits.push(`${fmtCount(r.failed)} could not be removed — those rows show the reason and stay selectable so you can retry.`);
  $('#receipt-detail').textContent = bits.join(' ');
  const trashRow = [...state.items.values()].find(i => i.abs && i.abs.endsWith('/.Trash') && selectable(i));
  $('#receipt-trash').hidden = !(moved && trashRow);
  $('#receipt-trash').onclick = () => {
    if (trashRow) openModal([trashRow.id]);
  };
  $('#receipt-errors').hidden = !r.failed;
}

// ------------------------------------------------------------- wire up ----

$('#scan-btn').addEventListener('click', () => {
  if (state.scan.status === 'scanning') post('/api/scan/cancel').catch(e => toast(e.message, true));
  else post('/api/scan/start').catch(e => toast(e.message, true));
});
$('#hero-scan').addEventListener('click', () => post('/api/scan/start').catch(e => toast(e.message, true)));
$('#fda-open').addEventListener('click', () => post('/api/settings/fda').catch(e => toast(e.message, true)));
$('#fda-relaunch').addEventListener('click', () => {
  try { window.webkit.messageHandlers.relaunch.postMessage(1); }
  catch { toast('Quit Mac Cleaner and open it again to finish granting access.', true); }
});
$('#fda-dismiss').addEventListener('click', () => {
  state.fdaDismissed = true;
  sessionStorage.setItem('cleaner-fda-dismissed', '1');
  markDirty();
});
$('#fda-lock').addEventListener('click', () => {
  state.fdaDismissed = false;
  sessionStorage.removeItem('cleaner-fda-dismissed');
  markDirty();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#clear-filters').addEventListener('click', clearFilters);
$('#kept-chip').addEventListener('click', unkeepAll);
$('#receipt-dismiss').addEventListener('click', () => { state.receipt = null; markDirty(); });
$('#receipt-errors').addEventListener('click', () => {
  // land the user ON the failures, not on an unfiltered list they must hunt
  state.filters.q = '';
  $('#search').value = '';
  state.filters.minBytes = 0;
  $('#min-size').value = '0';
  state.filters.safety = null;
  state.filters.errorsOnly = true;
  const first = [...state.items.values()].find(i => i.status === 'error');
  if (first) location.hash = '#g/' + encodeURIComponent(groupOf(first));
  markDirty();
});
$('#search').addEventListener('input', (e) => { state.filters.q = e.target.value.trim(); markDirty(); });
$('#min-size').addEventListener('change', (e) => { state.filters.minBytes = Number(e.target.value); markDirty(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; markDirty(); });

$('#detail-back').addEventListener('click', closeGroup);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) { $('#modal').hidden = true; return; }
  if (e.key === 'Escape' && ['group', 'settings'].includes(state.view.name)
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { closeGroup(); return; }
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('#search').focus();
  }
});

for (const tile of document.querySelectorAll('.tile-safety')) {
  tile.addEventListener('click', () => {
    const s = tile.dataset.safety;
    state.filters.safety = state.filters.safety === s ? null : s;
    markDirty();
  });
}

$('#select-safe').addEventListener('click', () => {
  // Acts on every safe item, not just the ones a filter happens to be showing
  // — the button's own label states the total it will select, and with a
  // safety tile active "visible" would have meant nothing at all.
  for (const i of state.items.values()) {
    // permanentOnly (Trash) never joins bulk-safe: emptying it is irreversible.
    // noTotal items live inside a build dir that gets selected anyway.
    if (i.safety === 'safe' && selectable(i) && !i.permanentOnly && !i.noTotal
        && !(i.badges || []).includes('active project')) state.selection.add(i.id);
  }
  markDirty();
});
$('#select-none').addEventListener('click', () => { state.selection.clear(); markDirty(); });
$('#sel-clear').addEventListener('click', () => { state.selection.clear(); markDirty(); });
$('#sel-clean').addEventListener('click', () => openModal([...state.selection]));

// ------------------------------------------------------- mode controls ----

function renderModeToggles() {
  for (const b of $('#mode-toggle').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === deleteMode()));
  }
  for (const b of $('#ui-mode-toggle').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.uimode === state.uiMode));
  }
  for (const c of document.querySelectorAll('#settings .mode-card')) {
    c.classList.toggle('current', c.dataset.uimode === state.uiMode);
  }
  for (const r of document.querySelectorAll('#settings input[name="delete-mode"]')) {
    r.checked = r.value === deleteMode();
  }
}

$('#mode-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setDeleteMode(b.dataset.mode);
});
$('#ui-mode-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setUiMode(b.dataset.uimode);
});
$('#open-settings').addEventListener('click', () => { location.hash = '#settings'; });
$('#settings-back').addEventListener('click', () => { location.hash = ''; });
for (const card of document.querySelectorAll('.mode-card')) {
  card.addEventListener('click', () => setUiMode(card.dataset.uimode));
}
for (const r of document.querySelectorAll('#settings input[name="delete-mode"]')) {
  r.addEventListener('change', () => { if (r.checked) setDeleteMode(r.value); });
}
$('#settings-fda-open').addEventListener('click', () => post('/api/settings/fda').catch(e => toast(e.message, true)));

renderModeToggles();
connect();
