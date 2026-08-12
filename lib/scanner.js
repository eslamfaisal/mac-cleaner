// Scan orchestrator: worker pool, item registry, claims dedup, cross-refs.

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, GROUPS, NORMAL_GROUPS, DEV_TO_NORMAL, NORMAL_FALLBACK_GROUP, buildStaticTargets, ELECTRON_SWEEP, CHROMIUM_PROFILE_SWEEP, SANDBOX_SWEEPS, UPDATER_SWEEP, ARTIFACT_RULES, WALK, prettyName } from './categories.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const THREADS = Math.max(2, Math.min(8, os.cpus().length - 2));

const display = (p) => p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;

// "2025.2.3" vs "2026.1" — numeric, segment by segment.
function cmpVersionStr(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const IDE_NAMES = {
  androidstudio: 'Android Studio', intellijidea: 'IntelliJ IDEA', pycharm: 'PyCharm',
  webstorm: 'WebStorm', phpstorm: 'PhpStorm', datagrip: 'DataGrip', goland: 'GoLand',
  clion: 'CLion', rubymine: 'RubyMine', rider: 'Rider', appcode: 'AppCode',
  dataspell: 'DataSpell', rustrover: 'RustRover', aqua: 'Aqua', writerside: 'Writerside',
  fleet: 'Fleet', mps: 'MPS',
};

function ideProductName(raw) {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (IDE_NAMES[key]) return IDE_NAMES[key];
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2');
}

let osVer;
function macOSVersion() {
  if (osVer === undefined) {
    try {
      const plist = fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
      osVer = (plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)</) || [])[1] || null;
    } catch { osVer = null; }
  }
  return osVer;
}

function fmtSize(n) {
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export class Scanner extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();          // id -> item
    this.claims = new Set();         // canonical paths claimed by items
    this.session = 0;
    this.status = 'idle';            // idle | scanning | done | cancelled
    this.tasksTotal = 0;
    this.tasksDone = 0;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.running = new Map();        // taskId -> {worker, task}
    this.nextId = 1;
    this.nextTask = 1;
    this.cancelSAB = null;
    this.gradlePins = new Map();     // version -> Set(project names)
    this.ndkPins = new Map();
    this.walkDenied = 0;
    this.duQueue = [];       // cloud rows waiting for an external du
    this.duRunning = 0;
  }

  state() {
    return { status: this.status, tasksDone: this.tasksDone, tasksTotal: this.tasksTotal, session: this.session, threads: THREADS };
  }

  // ------------------------------------------------------------ lifecycle --

  startScan() {
    if (this.status === 'scanning') return;
    this.session++;
    this.items.clear();
    this.claims.clear();
    this.queue = [];
    this.running.clear();
    this.tasksTotal = 0;
    this.tasksDone = 0;
    this.nextId = 1;
    this.nextTask = 1;
    this.gradlePins.clear();
    this.ndkPins.clear();
    this.walkDenied = 0;
    this.duQueue = [];
    this.duRunning = 0;
    this.pendingAsync = 0;
    this.dupCandidates = [];
    this.hashResults = new Map();    // `${size}:${hash}` -> [{path,size,mtime}]
    this.dupPhase = 0;               // 0 = collecting, 1 = hashing, 2 = registered
    this.status = 'scanning';
    this.cancelSAB = new SharedArrayBuffer(4);
    this.emit('scan-status');

    for (let i = 0; i < THREADS; i++) {
      const w = new Worker(WORKER_PATH, { workerData: { cancelSAB: this.cancelSAB } });
      w.on('message', (m) => this.onWorkerMessage(w, m));
      w.on('error', () => this.handleWorkerDeath(w, session));
      w.on('exit', (code) => { if (code !== 0) this.handleWorkerDeath(w, session); });
      this.workers.push(w);
      this.idle.push(w);
    }

    // simctl result decides orphan badges on simulator devices — fetch it
    // first (fast), then register everything and kick off the walk.
    const session = this.session;
    this.fetchSimDevices((simDevices, simctlOk) => {
      if (this.session !== session || this.status !== 'scanning') return;
      this.simDevices = simDevices;
      this.simctlOk = simctlOk;
      this.registerStaticTargets();
      this.registerElectronSweep();
      this.registerChromiumProfileSweep();
      this.registerSandboxSweep();
      this.registerUpdaterSweep();
      this.registerVolumeTrashes();
      this.registerPersonal();
      this.registerApplications();
      this.registerStaleIdeVersions();
      this.resolveFlutterCache();
      this.resolveSystemData();

      // Home walk (worker fans out depth<=2 into parallel subtasks)
      const claimedSnapshot = [...this.claims, ...WALK.topExcludes.map(n => path.join(HOME, n))];
      this.walkConfig = {
        maxDepth: WALK.maxDepth,
        fanoutDepth: WALK.fanoutDepth,
        claimed: claimedSnapshot,
        rules: ARTIFACT_RULES.filter(r => r.dir),
        prefixRules: ARTIFACT_RULES.filter(r => r.prefix),
        largeFileMin: WALK.largeFileMin,
        binaryExts: WALK.binaryExts,
        binaryMin: WALK.binaryMin,
        installerExts: WALK.installerExts,
        installerMin: WALK.installerMin,
        downloadsDir: path.join(HOME, 'Downloads'),
        home: HOME,
        dupMin: WALK.dupMin,
        packageSkips: WALK.packageSkips,
      };
      this.submit({ type: 'walk', root: HOME, depth: 0, config: this.walkConfig });
      // media dirs are excluded from the main walk — dedicated tasks find the
      // biggest files and duplicate candidates a normal user actually has
      for (const d of WALK.mediaDirs) {
        const root = path.join(HOME, d);
        try { if (fs.statSync(root).isDirectory()) this.submit({ type: 'media-walk', root, config: this.walkConfig }); } catch {}
      }
      this.emit('progress');
    });
  }

  fetchSimDevices(cb) {
    // On a Mac without Xcode, `xcrun` pops Apple's "install the command line
    // developer tools?" dialog — on every scan, for the exact audience that
    // has no idea what that is — and stalls all registration behind its
    // timeout. No simulator directory means there is nothing to ask about.
    try { fs.statSync(path.join(HOME, 'Library/Developer/CoreSimulator/Devices')); }
    catch { cb(new Map(), false); return; }
    execFile('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const map = new Map();
      let ok = false;
      if (!err) {
        try {
          const json = JSON.parse(stdout);
          for (const [runtimeId, devices] of Object.entries(json.devices || {})) {
            const runtime = runtimeId.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, ' ').replace(/ (\d+) (\d+)/, ' $1.$2');
            for (const d of devices) map.set(d.udid, { name: d.name, runtime });
          }
          ok = true; // parsed successfully — an empty map now really means "no devices"
        } catch {}
      }
      cb(map, ok);
    });
  }

  handleWorkerDeath(w, session) {
    // A dead worker must not strand its in-flight task or the whole scan.
    if (session !== this.session || this.status !== 'scanning') return;
    this.workers = this.workers.filter(x => x !== w);
    this.idle = this.idle.filter(x => x !== w);
    for (const [taskId, r] of [...this.running]) {
      if (r.worker !== w) continue;
      this.running.delete(taskId);
      this.tasksDone++;
      if (r.task.itemId) {
        const item = this.items.get(r.task.itemId);
        if (item && item.status === 'scanning') { item.status = 'error'; item.error = 'scan worker died'; this.emit('item', item); }
      }
    }
    this.emit('progress');
    this.dispatch();
    this.maybeFinish();
  }

  cancelScan() {
    if (this.status !== 'scanning') return;
    if (this.cancelSAB) Atomics.store(new Int32Array(this.cancelSAB), 0, 1);
    this.queue = [];
    this.finishScan('cancelled');
  }

  finishScan(status) {
    if (status === 'done') this.promoteUnpinnedWrappers();
    this.status = status;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.running.clear();
    this.emit('scan-status');
    this.emit('done');
  }

  maybeFinish() {
    if (!(this.status === 'scanning' && this.queue.length === 0 && this.running.size === 0 && this.pendingAsync === 0)) return;
    // Duplicate detection runs as a tail phase: the walks collected size
    // candidates; only size-collisions get hashed, then clusters register.
    if (this.dupPhase === 0) {
      this.dupPhase = 1;
      if (this.submitDupHashTasks() > 0) return; // hash tasks now queued
    }
    if (this.dupPhase === 1) {
      this.dupPhase = 2;
      this.registerDuplicates();
    }
    this.finishScan('done');
  }

  // ---------------------------------------------------- duplicates --------

  submitDupHashTasks() {
    const bySize = new Map();
    for (const f of this.dupCandidates) {
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }
    this.dupCandidates = [];
    // only size-collisions are worth hashing; biggest potential savings first,
    // hard cap keeps the tail phase bounded on huge disks (600 groups × ~384KB
    // sampled reads ≈ a few hundred MB of IO, still a couple of seconds)
    const groups = [...bySize.values()].filter(g => g.length >= 2);
    groups.sort((a, b) => b[0].size * (b.length - 1) - a[0].size * (a.length - 1));
    const files = groups.slice(0, 600).flat();
    let submitted = 0;
    for (let i = 0; i < files.length; i += 40) {
      this.submit({ type: 'hash', files: files.slice(i, i + 40) });
      submitted++;
    }
    return submitted;
  }

  registerDuplicates() {
    const clusters = [...this.hashResults.entries()].filter(([, c]) => c.length >= 2)
      .sort((a, b) => b[1][0].size * (b[1].length - 1) - a[1][0].size * (a[1].length - 1));
    for (const [key, copies] of clusters.slice(0, 200)) {
      copies.sort((a, b) => b.mtime - a.mtime); // newest first
      const label = `${path.basename(copies[0].path)} — ${copies.length} copies × ${fmtSize(copies[0].size)}`;
      copies.forEach((c, idx) => {
        const newest = idx === 0;
        const item = this.registerItem({
          group: 'duplicates',
          name: path.basename(c.path),
          path: c.path,
          kind: 'file',
          safety: 'caution',
          why: `Identical content to ${copies.length - 1} other file${copies.length > 2 ? 's' : ''} (same size and checksum). Keep at least one copy.`,
          regen: 'The other copies remain untouched.',
          bytes: c.size, files: 1, mtime: c.mtime, sized: true,
          badges: newest ? ['newest — suggest keep'] : ['duplicate copy'],
        }, { allowOverlap: true, claim: false });
        if (item) {
          // The label rounds sizes for humans, so two unrelated sets can share
          // it — grouping on it merged them, and "keep one copy" then kept a
          // copy of the wrong content. Identity is the content hash; the label
          // is only what the header shows.
          item.dupSet = key;
          item.project = label;
          item.projectName = label;
          item.dupNewest = newest;
          // a file already listed as a big file / installer is counted there;
          // counting it again here would advertise space twice
          if (this.claimedAncestor(item.real) || this.claims.has(item.real)) item.noTotal = true;
          this.emit('item', item);
        }
      });
    }
    this.hashResults.clear();
  }

  // ------------------------------------------------------------ pool ------

  submit(task) {
    task.taskId = this.nextTask++;
    task.session = this.session;
    this.tasksTotal++;
    this.queue.push(task);
    this.dispatch();
  }

  dispatch() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const task = this.queue.shift();
      this.running.set(task.taskId, { worker: w, task });
      w.postMessage(task);
    }
  }

  onWorkerMessage(w, m) {
    // drop messages from a previous session (queued before cancel/rescan)
    if (m.session !== undefined && m.session !== this.session) return;
    switch (m.type) {
      case 'task-complete': {
        const r = this.running.get(m.taskId);
        if (r) { this.running.delete(m.taskId); this.idle.push(r.worker); }
        this.tasksDone++;
        this.emit('progress');
        this.dispatch();
        this.maybeFinish();
        break;
      }
      case 'size-progress':
      case 'size-done': {
        const item = this.items.get(m.itemId);
        if (!item || ['deleted', 'gone', 'deleting', 'queued'].includes(item.status)) break;
        item.bytes = m.bytes; item.files = m.files; item.denied = m.denied;
        if (m.type === 'size-done') item.status = this.finalStatus(item, m);
        this.emit('item', item);
        break;
      }
      case 'task-error': {
        if (m.itemId) {
          const item = this.items.get(m.itemId);
          if (item && item.status === 'scanning') { item.status = 'error'; item.error = m.error; this.emit('item', item); }
        }
        break;
      }
      case 'found-artifact': if (this.status === 'scanning') this.onArtifact(m); break;
      case 'found-file': if (this.status === 'scanning') this.onFoundFile(m); break;
      case 'found-package': if (this.status === 'scanning') this.onFoundPackage(m); break;
      case 'dup-candidates': if (this.status === 'scanning') this.dupCandidates.push(...m.files); break;
      case 'hash-result': {
        const key = m.size + ':' + m.hash;
        if (!this.hashResults.has(key)) this.hashResults.set(key, []);
        this.hashResults.get(key).push({ path: m.path, size: m.size, mtime: m.mtime });
        break;
      }
      case 'walk-subtask':
        if (this.status === 'scanning') this.submit({ type: 'walk', root: m.dir, depth: m.depth, config: this.walkConfig });
        break;
      case 'walk-status': this.emit('walk-status', m.dir); break;
      case 'walk-done': this.walkDenied += m.denied || 0; break;
      case 'gradle-pin': this.onGradlePin(m); break;
      case 'ndk-pin': this.onNdkPin(m); break;
    }
  }

  finalStatus(item, m) {
    if (m.missing) return 'missing';
    if (m.cancelled) return 'done';
    if (item.bytes === 0 && item.denied > 0 && item.files === 0) return 'denied';
    return 'done';
  }

  // ------------------------------------------------------------ registry --

  registerItem(spec, { allowOverlap = false, claim = true } = {}) {
    let real;
    try { real = fs.realpathSync(spec.path); } catch { return null; }
    // Two kinds of overlap, with opposite consequences. An already-claimed
    // ANCESTOR means this item is part of something already listed — skip it.
    // An already-claimed DESCENDANT (a narrower target registered earlier)
    // must not make the wider one disappear: carve the claimed subtrees out
    // of both the size and the delete instead, so the remainder stays visible
    // and every byte is still counted exactly once.
    let carve = null;
    if (!allowOverlap) {
      if (this.claimedAncestor(real)) return null;
      carve = this.claimedCarve(real);
      if (carve && spec.kind === 'files') return null; // file lists can't carve
    }
    const id = `s${this.session}:${this.nextId++}`;
    const item = {
      id,
      group: spec.group,
      // normal-user taxonomy: explicit per-target override wins, else the
      // group's default mapping, else the collapsed developer card
      normalGroup: spec.normalGroup || DEV_TO_NORMAL[spec.group] || NORMAL_FALLBACK_GROUP,
      name: spec.name,
      path: spec.path,
      real,
      display: display(spec.path),
      safety: spec.safety,
      why: spec.why || '',
      regen: spec.regen || '',
      kind: spec.kind || 'dir',
      paths: spec.paths,
      // only a direct-child carve can be preserved through a delete; a deeper
      // one is excluded from the SIZE only, so cleaning this row removes the
      // nested rows too — it frees at least what it reports, never less
      deleteMode: carve && carve.names ? 'contents' : (spec.deleteMode || 'self'),
      contentsExclude: carve && carve.names
        ? [...new Set([...(spec.contentsExclude || []), ...carve.names])]
        : spec.contentsExclude,
      permanentOnly: !!spec.permanentOnly,
      displayOnly: !!spec.displayOnly,
      needs: spec.needs || null,
      badges: spec.badges || [],
      status: 'scanning',
      bytes: spec.bytes || 0,
      files: spec.files || 0,
      denied: 0,
      mtime: spec.mtime,
    };
    this.items.set(id, item);
    if (claim) this.claims.add(real);
    if (spec.sized) {
      item.status = 'done';
    } else if (item.kind === 'files') {
      this.sizeFileList(item);
    } else if (spec.sizeVia === 'du') {
      this.sizeExternally(item);
    } else {
      // Anything the delete deliberately keeps must not be counted as space
      // this row can free — JetBrains LocalHistory (unsaved-change recovery)
      // is preserved by contentsExclude and was still inflating the number.
      const kept = item.deleteMode === 'contents' && item.contentsExclude
        ? item.contentsExclude.map(n => path.join(real, n)) : [];
      const exclude = [...new Set([...(carve ? carve.paths : []), ...kept])];
      this.submit({
        type: 'size', itemId: id, target: item.path,
        reportBinaries: !!spec.reportBinaries,
        exclude: exclude.length ? exclude : undefined,
      });
    }
    // Only claim a sub-folder is "listed separately" when the delete really
    // spares it; a size-only carve gets no badge, because cleaning this row
    // would remove those bytes too.
    if (carve && carve.names) {
      const n = carve.names.length;
      item.badges = [...item.badges, `${n} sub-folder${n === 1 ? '' : 's'} listed separately`];
    }
    this.emit('item', item);
    return item;
  }

  overlapsClaim(p) {
    return this.claimedAncestor(p) || this.claimsUnder(p).length > 0;
  }

  // self or any parent already claimed → p is inside something already listed
  claimedAncestor(p) {
    if (this.claims.has(p)) return true;
    let cur = p;
    while (cur.length > 1 && cur !== '/') {
      cur = path.dirname(cur);
      if (this.claims.has(cur)) return true;
    }
    return false;
  }

  claimsUnder(p) {
    const pref = p + '/';
    const out = [];
    for (const c of this.claims) if (c.startsWith(pref)) out.push(c);
    return out;
  }

  // Describes how to carve already-listed subtrees out of a wider item.
  //   paths — exact claims, excluded from the size (the sizer matches full paths)
  //   names — set only when every claim is a DIRECT child, because that is the
  //           only case the delete path can express (it excludes by name).
  // Collapsing a deep claim to its first segment would exclude far more than
  // was claimed: every container claim is <id>/Data/Library/Caches, so naming
  // "Data" would blank out the whole container and still badge it as if the
  // missing bytes were listed elsewhere.
  claimedCarve(p) {
    const under = this.claimsUnder(p);
    if (!under.length) return null;
    const rel = under.map(c => c.slice(p.length + 1));
    const direct = rel.every(r => !r.includes('/'));
    return { paths: under, names: direct ? [...new Set(rel)] : null };
  }

  // Cloud mirrors (~/Library/Mobile Documents, ~/Library/CloudStorage) are
  // served by a File Provider daemon: a single readdir or lstat inside them
  // can block forever when the daemon stalls, and that permanently pins one
  // of the scan's worker threads — the scan then never finishes. Measure
  // those with a separate `du` process instead, which can be timed out and
  // killed. A missing size is a far better outcome than a hung scan.
  sizeExternally(item) {
    const session = this.session;
    this.pendingAsync++;
    this.duQueue.push({ item, session });
    this.pumpDu();
  }

  // Fifty simultaneous du walks against one File Provider daemon is what makes
  // the timeouts fire in the first place; four keeps the daemon responsive and
  // finishes in the same wall time when it is healthy.
  pumpDu() {
    while (this.duRunning < 4 && this.duQueue.length) {
      const { item, session } = this.duQueue.shift();
      this.duRunning++;
      this.runDu(item, session, 20000, () => {
        // one slower retry before giving up: a big cloud mirror that needs
        // more than 20s is exactly the row whose size the user came to see
        this.runDu(item, session, 120000, () => {
          item.badges = [...item.badges, 'too big to measure quickly'];
          this.finishDu(item, session);
        });
      });
    }
  }

  runDu(item, session, timeout, onFail) {
    execFile('/usr/bin/du', ['-skx', item.path], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      // a cancelled/restarted scan already zeroed pendingAsync and the queue;
      // this slot just goes away
      if (this.session !== session) { this.duRunning--; return; }
      const kb = parseInt(String(stdout || '').trim().split(/\s+/)[0], 10);
      if (err && err.killed) { onFail(); return; }
      if (!isNaN(kb)) item.bytes = kb * 1024;
      else item.badges = [...item.badges, 'size not available'];
      this.finishDu(item, session);
    });
  }

  finishDu(item, session) {
    if (this.session !== session) { this.duRunning--; return; }
    this.duRunning--;
    this.pendingAsync--;
    item.status = 'done';
    this.emit('item', item);
    this.pumpDu();
    this.maybeFinish();
  }

  sizeFileList(item) {
    let bytes = 0, files = 0;
    for (const p of item.paths) {
      try { const st = fs.lstatSync(p); bytes += st.blocks * 512; files++; } catch {}
    }
    item.bytes = bytes; item.files = files; item.status = 'done';
  }

  // ---------------------------------------------------- static targets ----

  registerStaticTargets() {
    for (const t of buildStaticTargets()) {
      let st;
      try { st = fs.lstatSync(t.path); } catch { continue; }
      if (t.kind === 'children' && st.isDirectory()) {
        this.registerChildren(t);
      } else {
        this.registerItem(t);
      }
    }
  }

  registerChildren(t) {
    let ents;
    try { ents = fs.readdirSync(t.path, { withFileTypes: true }); }
    catch {
      this.registerItem({ ...t, kind: 'dir', name: t.name + ' (no access)' });
      return;
    }
    // only trust the simctl cross-ref if simctl actually answered — a failed
    // call must NOT make every healthy simulator look like an orphan
    const simInfo = t.crossRef === 'simctl' && this.simctlOk ? this.simDevices : null;
    // Newest AndroidStudio version dir = current install (heuristic)
    let asCurrent = null;
    if (t.crossRef === 'as-version') {
      // numeric version compare — lexical sort would rank legacy "4.2" above "2024.3"
      const verKey = (name) => name.replace(/^AndroidStudio/, '').split('.').map(n => parseInt(n, 10) || 0);
      const cmp = (a, b) => {
        const va = verKey(a), vb = verKey(b);
        for (let i = 0; i < Math.max(va.length, vb.length); i++) {
          const d = (va[i] || 0) - (vb[i] || 0);
          if (d) return d;
        }
        return 0;
      };
      const versions = ents.filter(e => e.isDirectory() && e.name.startsWith('AndroidStudio')).map(e => e.name).sort(cmp);
      asCurrent = versions[versions.length - 1] || null;
    }

    for (const ent of ents) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (t.childFilter && !t.childFilter(ent.name)) continue;
      if (t.childExclude && t.childExclude.includes(ent.name)) continue;
      const p = path.join(t.path, ent.name);
      if (t.generic && this.claimedAncestor(p)) continue;

      const spec = {
        group: t.group,
        normalGroup: t.normalGroup,
        name: prettyName(ent.name),
        path: p,
        safety: t.safety,
        why: t.why,
        regen: t.regen,
        displayOnly: t.displayOnly,
        needs: t.needs,
        sizeVia: t.sizeVia,
        badges: [],
      };

      if (t.contentsExclude) {
        spec.deleteMode = t.childDeleteMode || 'contents';
        spec.contentsExclude = t.contentsExclude;
        if (t.contentsExclude.some(n => fs.existsSync(path.join(p, n)))) {
          spec.badges.push('keeps ' + t.contentsExclude.join(', '));
        }
      }

      if (t.crossRef === 'gradle-pin') {
        if (/^\d+(\.\d+)+$/.test(ent.name)) { spec.name = 'Gradle ' + ent.name; spec.gradleVersion = ent.name; }
        else if (ent.name === 'modules-2') { spec.name = 'modules-2 (downloaded dependencies)'; spec.safety = 'caution'; spec.why = 'All downloaded dependency JARs shared across Gradle versions.'; }
      }
      if (t.crossRef === 'ndk-pin' && /^\d+(\.\d+)+$/.test(ent.name)) { spec.name = 'NDK ' + ent.name; spec.ndkVersion = ent.name; }
      if (t.crossRef === 'as-version' && ent.name.startsWith('AndroidStudio')) {
        if (ent.name === asCurrent) { spec.badges.push('current — keep'); spec.safety = 'caution'; }
        else spec.badges.push('old version');
      }
      if (simInfo) {
        const dev = simInfo.get(ent.name);
        if (dev) { spec.name = `${dev.name} (${dev.runtime})`; spec.safety = 'caution'; }
        else { spec.name = ent.name.slice(0, 8) + '… — orphaned'; spec.safety = 'safe'; spec.badges.push('orphaned runtime'); spec.why = 'Simulator whose runtime was removed — cannot boot.'; spec.regen = 'Nothing to restore; it is already unusable.'; }
      }
      if (t.crossRef === 'avd') {
        this.registerAvd(p, ent.name, t);
        continue;
      }

      const item = this.registerItem(spec);
      if (item && spec.gradleVersion) item.gradleVersion = spec.gradleVersion;
      if (item && spec.ndkVersion) item.ndkVersion = spec.ndkVersion;
      // "Ahmed's iPhone — last backup 12 Mar 2024" beats a 40-char UDID by a
      // mile when deciding which backups are still worth their gigabytes
      if (item && t.crossRef === 'ios-backup') this.labelIosBackup(item);
    }
  }

  // Info.plist inside a backup is a binary plist holding <date> and <data>
  // values, which `plutil -convert json` refuses outright ("Invalid object in
  // plist for JSON format"). Reading one key at a time with -extract is the
  // only form that works — each key is independent, so a device with no
  // "Product Name" still gets its name and date.
  labelIosBackup(item) {
    const session = this.session;
    const plist = path.join(item.path, 'Info.plist');
    if (!fs.existsSync(plist)) return;
    const KEYS = [['device', 'Device Name'], ['product', 'Product Name'], ['last', 'Last Backup Date']];
    const info = {};
    let remaining = KEYS.length;
    this.pendingAsync += KEYS.length;
    for (const [field, key] of KEYS) {
      execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist],
        { timeout: 10000 }, (err, stdout) => {
          if (this.session !== session) return;
          this.pendingAsync--;
          // a missing key exits non-zero — that field simply stays unset
          if (!err && stdout.trim()) info[field] = stdout.trim();
          if (--remaining === 0) this.applyBackupLabel(item, info);
          this.maybeFinish();
        });
    }
  }

  applyBackupLabel(item, info) {
    if (!info.device) return;
    const product = info.product;
    item.name = product && !info.device.includes(product) ? `${info.device} (${product})` : info.device;
    const last = info.last ? new Date(info.last) : null;
    if (last && !isNaN(last)) {
      item.badges = [...item.badges, `last backup ${last.toISOString().slice(0, 10)}`];
      item.mtime = last.getTime();
    }
    this.emit('item', item);
  }

  registerAvd(avdPath, name, t) {
    const avdName = name.replace(/\.avd$/, '');
    const snapshots = path.join(avdPath, 'snapshots');
    if (fs.existsSync(snapshots)) {
      this.registerItem({
        group: t.group, name: `${avdName} — snapshots`, path: snapshots, safety: 'safe',
        why: 'Emulator quick-boot snapshots. The device itself stays intact.',
        regen: 'Emulator cold-boots once, then saves new snapshots.',
      });
    }
    const wipeFiles = ['userdata-qemu.img', 'userdata-qemu.img.qcow2', 'cache.img', 'cache.img.qcow2', 'sdcard.img', 'sdcard.img.qcow2']
      .map(f => path.join(avdPath, f)).filter(f => fs.existsSync(f));
    if (wipeFiles.length) {
      this.registerItem({
        group: t.group, name: `${avdName} — user data (wipe, keep device)`, kind: 'files', paths: wipeFiles,
        path: avdPath, safety: 'caution',
        why: 'Emulator user data (installed apps, settings). The AVD itself survives.',
        regen: 'Emulator boots fresh, like a factory-reset phone.',
        deleteMode: 'files',
      }, { allowOverlap: true, claim: false });
    }
    const whole = this.registerItem({
      group: t.group, name: `${avdName} (entire emulator)`, path: avdPath, safety: 'risky',
      why: t.why, regen: t.regen,
    }, { allowOverlap: true });
    // the companion <name>.ini must go with the AVD dir or Device Manager
    // shows a phantom device
    const ini = avdPath.replace(/\.avd$/, '.ini');
    if (whole && fs.existsSync(ini)) whole.extraDelete = [ini];
  }

  // Wrapper dists a completed walk found no project pin for are auto
  // re-downloaded by ./gradlew — same cost profile as the (safe) version
  // caches. Only runs on a full 'done' scan, never after cancel.
  promoteUnpinnedWrappers() {
    for (const item of this.items.values()) {
      if (item.path.includes('/.gradle/wrapper/dists/') && item.safety === 'caution'
          && !item.badges.some(b => b.startsWith('pinned'))
          && !['deleted', 'gone', 'deleting', 'queued'].includes(item.status)) {
        item.safety = 'safe';
        item.badges.push('no project pins this version');
        this.emit('item', item);
      }
    }
  }

  // ---------------------------------------------------- electron sweep ----

  registerElectronSweep() {
    const { base, subdirs, safety, why, regen, skipApps } = ELECTRON_SWEEP;
    let apps;
    try { apps = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const app of apps) {
      if (!app.isDirectory() || app.isSymbolicLink() || skipApps.includes(app.name)) continue;
      // An IDE's Electron cache belongs with the IDE, not in "App Caches".
      // Rather than keep a list of editors (a new one ships every month), take
      // the category the catalog already gave this app's own folder.
      const normalGroup = this.siblingNormalGroup(path.join(base, app.name));
      for (const sub of subdirs) {
        const p = path.join(base, app.name, sub);
        if (this.claimedAncestor(p)) continue;
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        this.registerItem({
          group: 'apps', normalGroup, name: `${app.name} — ${sub}`, path: p, safety, why, regen,
        });
      }
    }
  }

  // Normal-mode category of an already-registered item living in (or under)
  // dir — used so sweeps inherit the catalog's classification instead of
  // defaulting everything to the generic app bucket.
  siblingNormalGroup(dir) {
    const pref = dir + '/';
    for (const item of this.items.values()) {
      if (item.real === dir || item.real.startsWith(pref)) return item.normalGroup;
    }
    return undefined;
  }

  // ------------------------------------------- chromium profile sweep -----

  registerChromiumProfileSweep() {
    const { browsers, rootSubdirs, profileSubdirs, safety, why, regen } = CHROMIUM_PROFILE_SWEEP;
    for (const b of browsers) {
      let ents;
      try { ents = fs.readdirSync(b.dir, { withFileTypes: true }); } catch { continue; }
      for (const sub of rootSubdirs) {
        const p = path.join(b.dir, sub);
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        this.registerItem({ group: 'browsers', name: `${b.name} — ${sub}`, path: p, safety, why, regen });
      }
      for (const ent of ents) {
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        for (const sub of profileSubdirs) {
          const p = path.join(b.dir, ent.name, sub);
          let st;
          try { st = fs.lstatSync(p); } catch { continue; }
          if (!st.isDirectory() || st.isSymbolicLink()) continue;
          this.registerItem({ group: 'browsers', name: `${b.name} ${ent.name} — ${sub}`, path: p, safety, why, regen });
        }
      }
    }
  }

  // ------------------------------------------------ sandbox cache sweep ---

  registerSandboxSweep() {
    for (const sw of SANDBOX_SWEEPS) {
      let ents;
      try { ents = fs.readdirSync(sw.base, { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        const p = path.join(sw.base, ent.name, sw.sub);
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        this.registerItem({
          group: 'caches-user',
          name: `${prettyName(ent.name)} — ${sw.label}`,
          path: p,
          safety: 'safe',
          why: 'Cache folder inside the app sandbox — macOS may purge these under storage pressure, so apps already tolerate losing them.',
          regen: 'Rebuilt automatically by the app.',
        });
      }
    }
  }

  // ------------------------------------------------ updater leftovers -----
  // Sparkle-updated apps keep the installer of every update they downloaded
  // inside their own cache dir. The parent cache folder is already listed, so
  // these rows are informational (noTotal) — but still individually cleanable,
  // because "old app updates" is exactly what a user goes looking for.

  registerUpdaterSweep() {
    const sw = UPDATER_SWEEP;
    let ents;
    try { ents = fs.readdirSync(sw.base, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const p = path.join(sw.base, ent.name, sw.sub);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      const overlapped = this.claimedAncestor(p);
      const item = this.registerItem({
        group: sw.group,
        normalGroup: sw.normalGroup,
        name: `${prettyName(ent.name)} — downloaded updates`,
        path: p,
        safety: sw.safety,
        why: sw.why,
        regen: sw.regen,
        badges: overlapped ? ['inside this app’s cache'] : [],
      }, { allowOverlap: overlapped, claim: !overlapped });
      if (item && overlapped) { item.noTotal = true; this.emit('item', item); }
    }
  }

  // -------------------------------------------- trash on other volumes ----
  // Every mounted disk has its own hidden Trash. Emptying the Trash in Finder
  // does cover them, but a forgotten external drive keeps deleted files
  // forever — and its space never shows up in the Mac's own storage bar.
  // Only local disks (/dev/disk*) are considered: walking a network share
  // would be slow and is not this tool's business.

  registerVolumeTrashes() {
    const session = this.session;
    this.pendingAsync++;
    execFile('/sbin/mount', [], { timeout: 8000 }, (err, stdout) => {
      if (this.session !== session || this.status !== 'scanning') return;
      this.pendingAsync--;
      if (!err) {
        const uid = String(process.getuid ? process.getuid() : 501);
        for (const line of stdout.split('\n')) {
          // "/dev/disk4s1 on /Volumes/Kingston (64GB) (apfs, local, ...)"
          // Anchor on the trailing option list, not the first "(" — volume
          // names legitimately contain parentheses, and matching the flags
          // against the whole line makes a disk named "…read-only…" invisible.
          const m = line.match(/^\/dev\/disk\S+ on (\/Volumes\/.+) \(([^()]*)\)\s*$/);
          if (!m) continue;
          const vol = m[1];
          if (m[2].split(',').some(f => f.trim() === 'read-only')) continue;
          const trash = path.join(vol, '.Trashes', uid);
          let st;
          try { st = fs.lstatSync(trash); } catch { continue; }
          if (!st.isDirectory() || st.isSymbolicLink()) continue;
          this.registerItem({
            group: 'trash',
            name: `Trash on “${path.basename(vol)}”`,
            path: trash,
            safety: 'safe',
            why: `Files you deleted while working on the disk “${path.basename(vol)}”. They still take up space on that disk.`,
            regen: 'Nothing comes back — this is the final delete.',
            deleteMode: 'contents',
            permanentOnly: true,
            badges: ['external disk'],
          });
        }
      }
      this.maybeFinish();
    });
  }

  // ---------------------------------------------------- cross-refs --------

  resolveFlutterCache() {
    // counts as outstanding work so the scan can't finish (and discard the
    // result) before the login shell answers
    const session = this.session;
    this.pendingAsync++;
    execFile('/bin/zsh', ['-lc', 'which flutter'], { timeout: 8000 }, (err, stdout) => {
      if (this.session !== session || this.status !== 'scanning') return;
      this.pendingAsync--;
      const candidates = [];
      if (!err && stdout.trim()) {
        try {
          const real = fs.realpathSync(stdout.trim());
          candidates.push(path.join(path.dirname(path.dirname(real)), 'bin', 'cache'));
        } catch {}
      }
      candidates.push(path.join(HOME, 'flutter/bin/cache'), path.join(HOME, 'development/flutter/bin/cache'));
      for (const c of candidates) {
        try { if (fs.statSync(c).isDirectory()) {
          this.registerItem({
            group: 'flutter', name: 'Flutter SDK cache (bin/cache)', path: c, safety: 'safe',
            why: 'Engine artifacts downloaded by the flutter tool.',
            regen: 'flutter precache / next flutter run re-downloads.',
          });
          break;
        } } catch {}
      }
      this.maybeFinish();
    });
  }

  // System Data items that need runtime resolution: Time Machine snapshot
  // count (tmutil) and the per-user /var/folders cache/temp dirs (getconf).
  // Same pendingAsync accounting as resolveFlutterCache.
  resolveSystemData() {
    const session = this.session;

    this.pendingAsync++;
    execFile('/usr/bin/tmutil', ['listlocalsnapshots', '/'], { timeout: 10000 }, (err, stdout) => {
      if (this.session !== session || this.status !== 'scanning') return;
      this.pendingAsync--;
      const count = err ? 0 : stdout.split('\n').filter(l => l.includes('com.apple.TimeMachine')).length;
      if (count > 0) {
        const item = this.registerItem({
          group: 'system-data',
          name: `Time Machine local snapshots (${count})`,
          path: '/System/Volumes/Data',
          safety: 'caution',
          why: 'Hourly APFS snapshots kept locally by Time Machine. They can hold many GB of "purgeable" space that macOS frees under pressure.',
          regen: 'Delete via terminal: sudo tmutil thinlocalsnapshots / 999999999999 4 — see suggested commands.',
          displayOnly: true,
          needs: 'root',
          sized: true,
          badges: ['size not visible to apps', 'delete via terminal'],
        }, { claim: false });
        if (item) {
          item.noTotal = true;
          item.display = 'tmutil listlocalsnapshots /';
          this.emit('item', item);
        }
      }
      this.maybeFinish();
    });

    // getconf answers with e.g. /var/folders/ab/xyz.../C/ — the per-user
    // system cache/temp dirs macOS hides inside "System Data". They are
    // user-owned so they size fine, but live deletion breaks running apps:
    // display-only, with an honest explanation.
    const confDirs = [
      { key: 'DARWIN_USER_CACHE_DIR', name: 'System-managed user cache (/var/folders …/C)',
        why: 'Per-user cache macOS keeps in /var/folders. Apps hold open files in here — deleting it live breaks running apps.',
        regen: 'A reboot (or macOS periodic maintenance) clears what is safe to clear.' },
      { key: 'DARWIN_USER_TEMP_DIR', name: 'System-managed user temp (/var/folders …/T)',
        why: 'Per-user temporary files in /var/folders, used by running apps right now.',
        regen: 'Cleared automatically on reboot.' },
    ];
    for (const c of confDirs) {
      this.pendingAsync++;
      execFile('/usr/bin/getconf', [c.key], { timeout: 5000 }, (err, stdout) => {
        if (this.session !== session || this.status !== 'scanning') return;
        this.pendingAsync--;
        const dir = err ? null : stdout.trim().replace(/\/+$/, '');
        if (dir && dir.startsWith('/var/folders/')) {
          this.registerItem({
            group: 'system-data', name: c.name, path: dir, safety: 'caution',
            why: c.why, regen: c.regen, displayOnly: true,
          });
        }
        this.maybeFinish();
      });
    }
  }

  onGradlePin({ version, project }) {
    const proj = path.basename(project);
    if (!this.gradlePins.has(version)) this.gradlePins.set(version, new Set());
    this.gradlePins.get(version).add(proj);
    for (const item of this.items.values()) {
      if (item.gradleVersion === version && !item.badges.some(b => b.startsWith('pinned'))) {
        item.badges.push(`pinned by ${proj}`);
        item.safety = 'caution';
        this.emit('item', item);
      }
      // wrapper dists (children like "gradle-9.6.0-bin") too
      if (item.path.includes('/.gradle/wrapper') && item.name.includes(version)
          && !item.badges.some(b => b.startsWith('pinned'))) {
        item.badges.push(`pinned by ${proj}`);
        this.emit('item', item);
      }
    }
  }

  onNdkPin({ version, project }) {
    const proj = path.basename(project);
    if (!this.ndkPins.has(version)) this.ndkPins.set(version, new Set());
    this.ndkPins.get(version).add(proj);
    for (const item of this.items.values()) {
      if (item.ndkVersion === version && !item.badges.some(b => b.startsWith('pinned'))) {
        item.badges.push(`pinned by ${proj}`);
        this.emit('item', item);
      }
    }
  }

  // ---------------------------------------------------- walker results ----

  onArtifact(m) {
    let real;
    try { real = fs.realpathSync(m.path); } catch { return; }
    if (this.claimedAncestor(real)) return;
    const projName = path.basename(m.project);
    const badges = [];
    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
    if (m.parentMtime && Date.now() - m.parentMtime < THIRTY_DAYS) badges.push('active project');
    const item = this.registerItem({
      group: 'projects',
      name: `${projName} / ${path.basename(m.path)}`,
      path: m.path,
      safety: m.safety,
      why: m.why,
      regen: m.regen,
      badges,
      reportBinaries: true,
    });
    if (item) {
      item.project = m.project;
      item.projectName = projName;
    }
  }

  onFoundFile(m) {
    let real;
    try { real = fs.realpathSync(m.path); } catch { return; }
    const insideArtifact = !!m.inArtifact;
    if (!insideArtifact && this.claimedAncestor(real)) return;
    const group = m.kind === 'large' ? 'large' : m.kind === 'binary' ? 'binaries' : 'installers';
    // a binary sitting OUTSIDE a build dir may be a deliberately archived
    // release (signing + exact source needed to reproduce) — never 'safe'
    // Big files: Downloads leftovers are usually re-downloadable (caution);
    // anything in personal folders is treated as real data (risky).
    const safety = m.kind === 'large' ? (m.inDownloads ? 'caution' : 'risky')
      : m.kind === 'binary' ? (insideArtifact ? 'safe' : 'caution') : 'caution';
    const why = m.kind === 'large'
      ? (m.media
        ? 'Big media file — review it yourself; deleting loses it unless you have a backup.'
        : m.inDownloads
          ? 'Big file sitting in Downloads — often a leftover you can re-download.'
          : 'Big file — judge for yourself whether it is still needed.')
      : m.kind === 'binary' ? (insideArtifact
        ? 'Built app binary inside build output — rebuilt by your next build.'
        : 'App binary outside any build folder — may be an archived release you want to keep.')
      : 'Installer/archive in Downloads — usually no longer needed after installing.';
    const regen = m.kind === 'binary' ? 'Next build regenerates it.'
      : m.kind === 'large' && !m.inDownloads ? 'Gone for good unless backed up elsewhere.'
      : 'Re-download if ever needed again.';
    const badges = insideArtifact ? ['inside build output'] : [];
    if (m.media) badges.push('media');
    const item = this.registerItem({
      group, name: path.basename(m.path), path: m.path, kind: 'file',
      safety, why, regen, bytes: m.bytes, files: 1, mtime: m.mtime, sized: true,
      badges,
    }, { allowOverlap: insideArtifact, claim: !insideArtifact });
    // binaries inside a listed build dir are already counted in the parent
    // item's size — exclude from totals so nothing double-counts
    if (item && insideArtifact) { item.noTotal = true; this.emit('item', item); }
  }

  onFoundPackage(m) {
    let real;
    try { real = fs.realpathSync(m.path); } catch { return; }
    if (this.claimedAncestor(real)) return;
    // Photos/Music libraries: sized so the user sees where the space went,
    // never deletable from here — one wrong click would erase a photo library
    this.registerItem({
      group: 'large',
      name: path.basename(m.path),
      path: m.path,
      safety: 'risky',
      why: 'A macOS media library (all your photos/music live inside this single package). Manage it from within the app that owns it — never delete it from a cleaner.',
      regen: 'Cannot be regenerated — this is your actual library. To reclaim space, use the app itself: empty its Recently Deleted album, or turn on “Optimise Mac Storage”.',
      displayOnly: true,
      // macOS gates photo/media libraries behind Full Disk Access, so without
      // it this reads as a bare 0 B — the largest thing on the disk, invisible
      needs: 'fda',
      badges: ['media library'],
    });
  }

  // -------------------------------------------------- personal & media ----
  // Items every Mac user has, no developer tools required.

  registerPersonal() {
    // The one thing inside a Photos library that is safe to remove: the photo
    // cache left by syncing to an old iPod/iPhone. Everything else in there is
    // the library itself.
    try {
      for (const e of fs.readdirSync(path.join(HOME, 'Pictures'), { withFileTypes: true })) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        if (!/\.(photoslibrary|migratedphotolibrary|aplibrary)$/i.test(e.name)) continue;
        const cache = path.join(HOME, 'Pictures', e.name, 'iPod Photo Cache');
        try { if (!fs.lstatSync(cache).isDirectory()) continue; } catch { continue; }
        this.registerItem({
          group: 'personal',
          normalGroup: 'n-media',
          name: `iPod photo cache — ${e.name.replace(/\.[^.]+$/, '')}`,
          path: cache,
          safety: 'safe',
          why: 'Downsized photo copies made for syncing to an old iPod or iPhone. Your actual photos are not in here.',
          regen: 'Only recreated if you sync photos to such a device again.',
          needs: 'fda',
        });
      }
    } catch {}

    // Screenshots sitting on the Desktop
    const desktop = path.join(HOME, 'Desktop');
    const shotRe = /^(screen ?shot|screenshot|cleanshot|screen ?recording)/i;
    const shotExts = ['.png', '.jpg', '.jpeg', '.mov', '.mp4', '.gif'];
    try {
      const shots = fs.readdirSync(desktop, { withFileTypes: true })
        .filter(e => e.isFile() && shotRe.test(e.name) && shotExts.includes(path.extname(e.name).toLowerCase()))
        .map(e => path.join(desktop, e.name));
      if (shots.length) {
        this.registerItem({
          group: 'personal',
          name: `Screenshots on Desktop (${shots.length})`,
          kind: 'files', paths: shots, path: desktop,
          safety: 'caution',
          why: 'Screen shots and recordings piling up on the Desktop.',
          regen: 'Gone once deleted — keep any you still need.',
          deleteMode: 'files',
        }, { allowOverlap: true, claim: false });
      }
    } catch {}

    // Old files in Downloads (top level, untouched for 90+ days)
    const downloads = path.join(HOME, 'Downloads');
    const NINETY_DAYS = 90 * 24 * 3600 * 1000;
    try {
      const old = [];
      let bytes = 0;
      for (const e of fs.readdirSync(downloads, { withFileTypes: true })) {
        if (!e.isFile() || e.name.startsWith('.')) continue;
        const p = path.join(downloads, e.name);
        try {
          const st = fs.lstatSync(p);
          if (Date.now() - st.mtimeMs > NINETY_DAYS && st.size >= 1024 * 1024) { old.push(p); bytes += st.blocks * 512; }
        } catch {}
      }
      if (old.length) {
        this.registerItem({
          group: 'personal',
          name: `Downloads untouched for 90+ days (${old.length})`,
          kind: 'files', paths: old, path: downloads,
          normalGroup: 'n-downloads',
          safety: 'caution',
          why: 'Files in Downloads you have not opened in three months — usually already installed, read, or forgotten.',
          regen: 'Most can be re-downloaded; check the list before deleting.',
          deleteMode: 'files',
        }, { allowOverlap: true, claim: false });
      }
    } catch {}
  }

  // ------------------------------------------------ applications ----------
  // Old & unused apps. Enumerates /Applications and ~/Applications, asks
  // Spotlight (mdls) for last-used date, bundle id and version, then flags:
  //   - apps not opened in 6+ months (or never opened, installed 30+ days ago)
  //   - older duplicate copies of the same app (same bundle id, lower version)
  // Apple's own apps (com.apple.*) are skipped — OS-managed, often SIP-locked.

  registerApplications() {
    const session = this.session;
    const roots = ['/Applications', path.join(HOME, 'Applications')];
    // system apps are never registered, but their names feed the leftover
    // matcher so FaceTime/Photos/... data is not mistaken for leftovers
    const systemRoots = ['/System/Applications', '/System/Applications/Utilities'];
    const apps = [];
    this.systemAppNames = [];
    for (const root of systemRoots) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.name.endsWith('.app')) this.systemAppNames.push(path.basename(e.name, '.app'));
        }
      } catch {}
    }
    for (const root of roots) {
      let ents;
      try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isSymbolicLink() || !e.isDirectory() || !e.name.endsWith('.app')) continue;
        apps.push(path.join(root, e.name));
      }
    }
    if (!apps.length) return;

    // Spotlight's last-used date is often missing (login-item apps, disabled
    // indexing) — a currently-running app must never be listed as unused.
    this.runningProcs = '';
    this.pendingAsync++;
    execFile('/bin/ps', ['-axo', 'comm'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (this.session !== session || this.status !== 'scanning') return;
      this.pendingAsync--;
      if (!err) this.runningProcs = stdout;
      this.maybeFinish();
    });

    const ATTRS = ['kMDItemCFBundleIdentifier', 'kMDItemLastUsedDate', 'kMDItemVersion'];
    const meta = new Map(); // app path -> { attr -> raw value }
    const chunks = [];
    for (let i = 0; i < apps.length; i += 20) chunks.push(apps.slice(i, i + 20));
    let remaining = chunks.length;
    this.pendingAsync += chunks.length;
    for (const chunk of chunks) {
      execFile('/usr/bin/mdls', [...ATTRS.flatMap(a => ['-name', a]), ...chunk],
        { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (this.session !== session || this.status !== 'scanning') return;
          this.pendingAsync--;
          if (!err && stdout) {
            // mdls prints the requested attributes per file, in file order,
            // with no filename header — a repeated attribute name starts the
            // next file's record.
            const recs = [];
            let cur = null;
            for (const line of stdout.split('\n')) {
              const m = line.match(/^(kMDItem\w+)\s*=\s*(.*)$/);
              if (!m) continue;
              if (!cur || m[1] in cur) { cur = {}; recs.push(cur); }
              cur[m[1]] = m[2].trim();
            }
            chunk.forEach((p, i) => { if (recs[i]) meta.set(p, recs[i]); });
          }
          if (--remaining === 0) this.classifyApplications(apps, meta);
          this.maybeFinish();
        });
    }
  }

  classifyApplications(apps, meta) {
    const now = Date.now();
    const SIX_MONTHS = 180 * 24 * 3600 * 1000;
    const unq = (v) => v && v !== '(null)' ? v.replace(/^"|"$/g, '') : null;
    const infos = [];
    const byBundle = new Map();
    for (const p of apps) {
      const r = meta.get(p) || {};
      let mtime = null;
      try { mtime = fs.lstatSync(p).mtimeMs; } catch { continue; }
      const info = {
        path: p,
        name: path.basename(p, '.app'),
        bundleId: unq(r.kMDItemCFBundleIdentifier),
        version: unq(r.kMDItemVersion),
        lastUsed: r.kMDItemLastUsedDate && r.kMDItemLastUsedDate !== '(null)' ? Date.parse(r.kMDItemLastUsedDate) : null,
        mtime,
      };
      infos.push(info);
      if (info.bundleId) {
        if (!byBundle.has(info.bundleId)) byBundle.set(info.bundleId, []);
        byBundle.get(info.bundleId).push(info);
      }
    }

    // Older duplicate copies: same bundle id installed more than once.
    const verKey = (v) => (v || '0').split(/[^\d]+/).map(n => parseInt(n, 10) || 0);
    const cmpVer = (a, b) => {
      const va = verKey(a.version), vb = verKey(b.version);
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (va[i] || 0) - (vb[i] || 0);
        if (d) return d;
      }
      return (a.mtime || 0) - (b.mtime || 0);
    };
    const oldCopies = new Map(); // path -> newest info
    for (const list of byBundle.values()) {
      if (list.length < 2) continue;
      list.sort(cmpVer);
      const newest = list[list.length - 1];
      for (const old of list.slice(0, -1)) oldCopies.set(old.path, newest);
    }

    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    // last-activity fallback: an app that writes its preferences plist is in
    // use even when Spotlight has no last-used date for it
    const prefMtime = (bid) => {
      if (!bid) return null;
      try { return fs.statSync(path.join(HOME, 'Library', 'Preferences', bid + '.plist')).mtimeMs; } catch { return null; }
    };
    const isRunning = (p) => this.runningProcs && this.runningProcs.includes(p + '/Contents/');
    // never offer to delete the app bundle this scanner is running from
    const selfBundle = WORKER_PATH.includes('.app/Contents/')
      ? WORKER_PATH.slice(0, WORKER_PATH.indexOf('.app/Contents/') + 4) : null;
    for (const info of infos) {
      if (selfBundle && info.path === selfBundle) continue;
      // Full macOS installers downloaded by Software Update — 12+ GB each and
      // usually forgotten after the upgrade ran.
      if (/^Install (macOS|OS X)\b/.test(info.name)) {
        this.registerItem({
          group: 'applications',
          name: `${info.name} — macOS installer`,
          path: info.path,
          safety: 'caution',
          why: `A complete macOS installer left in /Applications (these are 12–16 GB)${macOSVersion() ? `. This Mac currently runs macOS ${macOSVersion()}` : ''}.`,
          regen: 'Re-downloadable from the App Store or Software Update if you ever need it again.',
          badges: ['installer'],
          mtime: info.mtime,
        });
        continue;
      }
      if (info.bundleId && info.bundleId.startsWith('com.apple.')) continue;
      const newest = oldCopies.get(info.path);
      if (newest) {
        this.registerItem({
          group: 'applications',
          name: `${info.name}${info.version ? ' ' + info.version : ''} — old version`,
          path: info.path,
          safety: 'caution',
          why: `An older copy of ${newest.name}${newest.version ? ` — version ${newest.version} is also installed` : ' — a newer copy is also installed'} (same bundle id).`,
          regen: 'The newer copy stays installed and keeps working.',
          badges: ['duplicate install'],
        });
        continue;
      }
      if (isRunning(info.path)) continue;
      const lastActive = Math.max(info.lastUsed || 0, prefMtime(info.bundleId) || 0) || null;
      // no activity signal at all → only flag genuinely old installs
      const unused = lastActive
        ? now - lastActive > SIX_MONTHS
        : now - info.mtime > SIX_MONTHS;
      if (!unused) continue;
      this.registerItem({
        group: 'applications',
        name: info.name,
        path: info.path,
        safety: 'caution',
        why: lastActive
          ? `No sign of use since ${day(lastActive)} (Spotlight + preferences). The app itself — its documents and settings are not touched.`
          : `Installed ${day(info.mtime)}, and no record of it being used since. The app itself — its documents and settings are not touched.`,
        regen: 'Reinstall from the App Store or the vendor’s site if you need it again.',
        badges: [lastActive ? `last used ${day(lastActive)}` : 'no sign of use'],
        mtime: info.mtime,
      });
    }

    this.registerAppLeftovers(infos);
  }

  // ----------------------------------------- superseded IDE version dirs --
  // JetBrains IDEs and Android Studio keep one settings/cache/log folder PER
  // VERSION (AndroidStudio2025.2.3, IntelliJIdea2024.3, ...). Upgrading never
  // removes the old ones, so years of dead per-version data pile up. Only
  // folders that are NOT the newest of their product are registered.
  // Also covers JetBrains Toolbox, which keeps old IDE builds on disk (GBs).

  registerStaleIdeVersions() {
    const VENDOR_ROOTS = [
      { dir: path.join(HOME, 'Library/Application Support/JetBrains'), label: 'settings & plugins', safety: 'caution',
        regen: 'Gone for good — the version still installed keeps its own settings.' },
      { dir: path.join(HOME, 'Library/Application Support/Google'), label: 'settings & plugins', safety: 'caution',
        regen: 'Gone for good — the version still installed keeps its own settings.' },
      { dir: path.join(HOME, 'Library/Caches/JetBrains'), label: 'caches & indexes', safety: 'safe',
        regen: 'Nothing to regenerate: the version it belonged to is gone.' },
      { dir: path.join(HOME, 'Library/Caches/Google'), label: 'caches & indexes', safety: 'safe',
        regen: 'Nothing to regenerate: the version it belonged to is gone.' },
      // ~/Library/Logs as a whole is already listed under System Caches & Logs
    ];
    for (const root of VENDOR_ROOTS) {
      let ents;
      try { ents = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
      const byProduct = new Map();
      for (const e of ents) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const m = e.name.match(/^([A-Za-z][A-Za-z ]*?)[ _-]?((?:\d{4}\.\d+|\d+)(?:\.\d+)*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (!byProduct.has(key)) byProduct.set(key, []);
        byProduct.get(key).push({ name: e.name, product: m[1], version: m[2] });
      }
      for (const list of byProduct.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => cmpVersionStr(a.version, b.version));
        const newest = list[list.length - 1];
        for (const old of list.slice(0, -1)) {
          this.registerItem({
            group: 'applications',
            normalGroup: 'n-dev',
            name: `${ideProductName(old.product)} ${old.version} — ${root.label}`,
            path: path.join(root.dir, old.name),
            safety: root.safety,
            why: `Left behind by an old ${ideProductName(old.product)} version. Version ${newest.version} is the one in use — this folder belongs to ${old.version} and nothing reads it any more.`,
            regen: root.regen,
            badges: [`superseded by ${newest.version}`],
          });
        }
      }
    }
    this.registerToolboxBuilds();
  }

  registerToolboxBuilds() {
    const APPS = path.join(HOME, 'Library/Application Support/JetBrains/Toolbox/apps');
    let ides;
    try { ides = fs.readdirSync(APPS, { withFileTypes: true }); } catch { return; }
    const isBuild = (n) => /^\d[\d.]*$/.test(n);
    for (const ide of ides) {
      if (!ide.isDirectory() || ide.isSymbolicLink()) continue;
      // layouts: apps/<Ide>/<build>  and  apps/<Ide>/ch-N/<build>
      const parents = [path.join(APPS, ide.name)];
      try {
        for (const c of fs.readdirSync(parents[0], { withFileTypes: true })) {
          if (c.isDirectory() && /^ch-\d+$/.test(c.name)) parents.push(path.join(parents[0], c.name));
        }
      } catch {}
      for (const parent of parents) {
        let builds;
        try {
          builds = fs.readdirSync(parent, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.isSymbolicLink() && isBuild(e.name))
            .map(e => e.name);
        } catch { continue; }
        if (builds.length < 2) continue;
        builds.sort(cmpVersionStr);
        const newest = builds[builds.length - 1];
        for (const old of builds.slice(0, -1)) {
          this.registerItem({
            group: 'applications',
            normalGroup: 'n-dev',
            name: `${ideProductName(ide.name)} build ${old} — old Toolbox install`,
            path: path.join(parent, old),
            safety: 'safe',
            why: `A previous build kept by JetBrains Toolbox after an update. Build ${newest} is the one Toolbox launches.`,
            regen: 'Toolbox can re-download any build; the current one is untouched.',
            badges: [`superseded by ${newest}`],
          });
        }
      }
    }
  }

  // -------------------------------------------- uninstalled-app leftovers --
  // Folders in ~/Library/Application Support and ~/Library/Containers whose
  // name matches no installed app — likely data left behind by uninstalls.
  // Matching is deliberately loose (tokens from app names AND bundle ids) so
  // anything ambiguous stays OUT of the list; what remains is still 'caution'
  // because command-line tools also store data here without an .app.

  registerAppLeftovers(infos) {
    if (infos.length < 5) return; // Spotlight/enumeration broken — too risky to guess
    const tokens = new Set();
    const ids = new Set();
    const GENERIC = new Set(['com', 'org', 'net', 'app', 'apps', 'mac', 'macos', 'inc', 'group', 'groups']);
    for (const name of this.systemAppNames || []) {
      const flat = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (flat.length >= 3) tokens.add(flat);
      for (const w of name.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4) tokens.add(w);
    }
    for (const a of infos) {
      if (a.bundleId) {
        ids.add(a.bundleId.toLowerCase());
        for (const seg of a.bundleId.toLowerCase().split('.')) {
          if (seg.length >= 4 && !GENERIC.has(seg)) tokens.add(seg);
        }
      }
      const nm = a.name.toLowerCase();
      const flat = nm.replace(/[^a-z0-9]+/g, '');
      if (flat.length >= 3) tokens.add(flat);
      for (const w of nm.split(/[^a-z0-9]+/)) if (w.length >= 4) tokens.add(w);
    }
    // infra & CLI-tool dirs that legitimately live here with no matching .app
    const SKIP = new Set([
      'mobilesync', 'clouddocs', 'addressbook', 'crashreporter', 'dock', 'icloud',
      'knowledge', 'fileprovider', 'syncservices', 'diskimages', 'appstore',
      'callhistorydb', 'callhistorytransactions', 'differentialprivacy',
      'sharedfilelist', 'networkserviceproxy', 'trial', 'homebrew', 'code',
      'claude', 'gemini', 'antigravity', 'google', 'jetbrains', 'steam', 'adobe', 'epic',
      // macOS internals that live here without a matching .app
      'animoji', 'controlcenter', 'certificateauthority', 'caches', 'assistant',
      'assistantsdk', 'coreparsec', 'proapps', 'perfpowerservices', 'rosettaupdateauto',
      'spotlight', 'appplaceholdersyncd', 'icloudmailagent', 'passkit', 'sharing',
      // dev toolchains without an .app bundle
      'dart', 'flutter', 'jxbrowser', 'virtualenv', 'pypoetry',
    ]);
    const STALE = 60 * 24 * 3600 * 1000; // recently-touched dirs belong to something alive
    const matchesInstalled = (dirName) => {
      const lower = dirName.toLowerCase();
      if (lower.startsWith('com.apple') || lower.startsWith('group.com.apple')) return true;
      // macOS background daemons write here and never have an .app
      if (/^[a-z]+d$/.test(dirName) && dirName.length <= 24) return true;
      const flat = lower.replace(/[^a-z0-9]+/g, '');
      if (!flat || SKIP.has(flat)) return true;
      if (ids.has(lower)) return true;
      for (const t of tokens) {
        if (t.length >= 4 && (flat.includes(t) || t.includes(flat))) return true;
        if (t === flat) return true;
      }
      return false;
    };

    const registerLeftover = (p, name, label, why) => {
      let real;
      try {
        real = fs.realpathSync(p);
        // a dir modified in the last 60 days is being written by something
        // still installed/running — not a leftover
        if (Date.now() - fs.lstatSync(p).mtimeMs < STALE) return;
      } catch { return; }
      // only an already-listed ANCESTOR means these bytes are counted
      // elsewhere; claimed sub-caches are carved out by registerItem instead,
      // so the folder keeps its real size in the totals
      const overlapped = this.claimedAncestor(real);
      const item = this.registerItem({
        group: 'leftovers',
        name: `${prettyName(name)} — ${label}`,
        path: p,
        safety: 'caution',
        why,
        regen: 'Gone once deleted; reinstalling the app recreates its defaults.',
        badges: ['no matching app installed'],
      }, { allowOverlap: overlapped, claim: !overlapped });
      // sub-caches may already be listed elsewhere — don't double-count
      if (item && overlapped) { item.noTotal = true; this.emit('item', item); }
    };

    const AS_DIR = path.join(HOME, 'Library', 'Application Support');
    try {
      for (const e of fs.readdirSync(AS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
        if (matchesInstalled(e.name)) continue;
        registerLeftover(path.join(AS_DIR, e.name), e.name, 'app data',
          'No installed application matches this folder — it looks like data left behind after an uninstall. Command-line tools also store data here, so double-check the name.');
      }
    } catch {}

    const CONTAINERS = path.join(HOME, 'Library', 'Containers');
    try {
      for (const e of fs.readdirSync(CONTAINERS, { withFileTypes: true })) {
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
        // UUID-named containers are macOS-managed (FileProvider etc.), not apps
        if (/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(e.name)) continue;
        if (matchesInstalled(e.name)) continue;
        registerLeftover(path.join(CONTAINERS, e.name), e.name, 'sandbox container',
          'Sandbox container for an app that no longer appears installed. Helper tools sometimes keep containers under a different id, so double-check the name.');
      }
    } catch {}
  }

  // ---------------------------------------------------- deletion hooks ----

  markDeleting(id) {
    const item = this.items.get(id);
    if (item) { item.status = 'deleting'; this.emit('item', item); }
  }

  markGone(id) {
    const item = this.items.get(id);
    if (item) { item.status = 'gone'; this.emit('item', item); }
  }

  markDeleted(id, ok, errMsg) {
    const item = this.items.get(id);
    if (!item) return;
    if (ok) {
      item.status = 'deleted';
      // Descendants of a deleted ancestor are gone too (e.g. AVD snapshots
      // when the whole AVD was deleted) — but don't count them as reclaimed.
      // Only when the item's WHOLE tree was actually removed: kind 'files'
      // deletes a few files and 'contents' keeps the dir, so no cascade.
      if (item.kind !== 'files' && item.deleteMode !== 'contents') {
        const pref = item.real + '/';
        for (const other of this.items.values()) {
          if (other !== item && other.status !== 'deleted' && (other.real.startsWith(pref) || other.real === item.real)) {
            other.status = 'gone';
            this.emit('item', other);
          }
        }
      }
    } else {
      item.status = 'error';
      item.error = errMsg;
    }
    this.emit('item', item);
  }
}

export { GROUPS, NORMAL_GROUPS, HOME };
