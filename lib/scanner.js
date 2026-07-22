// Scan orchestrator: worker pool, item registry, claims dedup, cross-refs.

import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, GROUPS, buildStaticTargets, ELECTRON_SWEEP, CHROMIUM_PROFILE_SWEEP, SANDBOX_SWEEPS, ARTIFACT_RULES, WALK, prettyName } from './categories.js';

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const THREADS = Math.max(2, Math.min(8, os.cpus().length - 2));

const display = (p) => p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p;

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
    this.pendingAsync = 0;
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
      this.resolveFlutterCache();

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
      };
      this.submit({ type: 'walk', root: HOME, depth: 0, config: this.walkConfig });
      this.emit('progress');
    });
  }

  fetchSimDevices(cb) {
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
    if (this.status === 'scanning' && this.queue.length === 0 && this.running.size === 0 && this.pendingAsync === 0) {
      this.finishScan('done');
    }
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
    if (!allowOverlap && this.overlapsClaim(real)) return null;
    const id = `s${this.session}:${this.nextId++}`;
    const item = {
      id,
      group: spec.group,
      name: spec.name,
      path: spec.path,
      real,
      display: display(spec.path),
      safety: spec.safety,
      why: spec.why || '',
      regen: spec.regen || '',
      kind: spec.kind || 'dir',
      paths: spec.paths,
      deleteMode: spec.deleteMode || 'self',
      contentsExclude: spec.contentsExclude,
      permanentOnly: !!spec.permanentOnly,
      displayOnly: !!spec.displayOnly,
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
    } else {
      this.submit({ type: 'size', itemId: id, target: item.path, reportBinaries: !!spec.reportBinaries });
    }
    this.emit('item', item);
    return item;
  }

  overlapsClaim(p) {
    if (this.claims.has(p)) return true;
    let cur = p;
    while (cur.length > 1 && cur !== '/') {
      cur = path.dirname(cur);
      if (this.claims.has(cur)) return true;
    }
    const pref = p + '/';
    for (const c of this.claims) if (c.startsWith(pref)) return true;
    return false;
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
      if (t.generic && this.overlapsClaim(p)) continue;

      const spec = {
        group: t.group,
        name: prettyName(ent.name),
        path: p,
        safety: t.safety,
        why: t.why,
        regen: t.regen,
        displayOnly: t.displayOnly,
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
    }
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
      for (const sub of subdirs) {
        const p = path.join(base, app.name, sub);
        if (this.overlapsClaim(p)) continue;
        let st;
        try { st = fs.lstatSync(p); } catch { continue; }
        if (!st.isDirectory()) continue;
        this.registerItem({
          group: 'apps', name: `${app.name} — ${sub}`, path: p, safety, why, regen,
        });
      }
    }
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
    if (this.overlapsClaim(real)) return;
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
    if (!insideArtifact && this.overlapsClaim(real)) return;
    const group = m.kind === 'large' ? 'large' : m.kind === 'binary' ? 'binaries' : 'installers';
    // a binary sitting OUTSIDE a build dir may be a deliberately archived
    // release (signing + exact source needed to reproduce) — never 'safe'
    const safety = m.kind === 'large' ? 'risky' : m.kind === 'binary' ? (insideArtifact ? 'safe' : 'caution') : 'caution';
    const why = m.kind === 'large' ? 'Large file — judge for yourself whether it is still needed.'
      : m.kind === 'binary' ? (insideArtifact
        ? 'Built app binary inside build output — rebuilt by your next build.'
        : 'App binary outside any build folder — may be an archived release you want to keep.')
      : 'Installer/archive in Downloads — usually no longer needed after installing.';
    const regen = m.kind === 'binary' ? 'Next build regenerates it.' : 'Re-download if ever needed again.';
    const item = this.registerItem({
      group, name: path.basename(m.path), path: m.path, kind: 'file',
      safety, why, regen, bytes: m.bytes, files: 1, mtime: m.mtime, sized: true,
      badges: insideArtifact ? ['inside build output'] : [],
    }, { allowOverlap: insideArtifact, claim: !insideArtifact });
    // binaries inside a listed build dir are already counted in the parent
    // item's size — exclude from totals so nothing double-counts
    if (item && insideArtifact) { item.noTotal = true; this.emit('item', item); }
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

export { GROUPS, HOME };
