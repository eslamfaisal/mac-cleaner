// Worker thread: directory sizing + project walking.
// Sync fs calls are intentional — each worker is a dedicated thread; sync
// iteration is the fastest way to walk and keeps memory flat (counters only).

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const cancel = new Int32Array(workerData.cancelSAB);
const isCancelled = () => Atomics.load(cancel, 0) === 1;

// every message echoes the task's session so the parent can drop stale
// messages after a cancel/rescan
let post = (msg) => parentPort.postMessage(msg);

parentPort.on('message', (task) => {
  post = (msg) => parentPort.postMessage({ ...msg, session: task.session });
  try {
    if (task.type === 'size') sizeTask(task);
    else if (task.type === 'walk') walkTask(task);
    else if (task.type === 'media-walk') mediaWalkTask(task);
    else if (task.type === 'hash') hashTask(task);
  } catch (err) {
    post({ type: 'task-error', taskId: task.taskId, itemId: task.itemId, error: String(err && err.message || err) });
  }
  post({ type: 'task-complete', taskId: task.taskId });
});

// ---------------------------------------------------------------- size ----

const BIN_EXTS = ['.apk', '.aab', '.ipa'];
const BIN_MIN = 5 * 1024 * 1024;

function sizeTask({ taskId, itemId, target, reportBinaries }) {
  let bytes = 0, files = 0, denied = 0;
  let lastPost = Date.now();
  // Hardlink dedup: only track inodes with nlink > 1 (pnpm/Bun stores) so the
  // set stays small on normal trees.
  const seenLinks = new Set();

  const report = (done) => post({ type: done ? 'size-done' : 'size-progress', taskId, itemId, bytes, files, denied });

  let rootSt;
  try { rootSt = fs.lstatSync(target); } catch {
    post({ type: 'size-done', taskId, itemId, bytes: 0, files: 0, denied: 0, missing: true });
    return;
  }
  if (!rootSt.isDirectory()) { bytes = rootSt.blocks * 512; files = 1; report(true); return; }

  const stack = [target];
  let entriesSinceCheck = 0;
  while (stack.length) {
    if (isCancelled()) { post({ type: 'size-done', taskId, itemId, bytes, files, denied, cancelled: true }); return; }
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { denied++; continue; }
    for (const ent of ents) {
      const p = dir + '/' + ent.name;
      if (ent.isDirectory() && !ent.isSymbolicLink()) { stack.push(p); continue; }
      try {
        const st = fs.lstatSync(p);
        if (st.nlink > 1 && !st.isDirectory()) {
          const key = st.dev + ':' + st.ino;
          if (seenLinks.has(key)) { files++; continue; }
          seenLinks.add(key);
        }
        bytes += st.blocks * 512;
        files++;
        if (reportBinaries && st.blocks * 512 >= BIN_MIN) {
          const lower = ent.name.toLowerCase();
          if (BIN_EXTS.some(x => lower.endsWith(x))) {
            post({ type: 'found-file', taskId, kind: 'binary', path: p, bytes: st.blocks * 512, mtime: st.mtimeMs, inArtifact: true });
          }
        }
      } catch { denied++; }
      if (++entriesSinceCheck >= 2048) {
        entriesSinceCheck = 0;
        if (isCancelled()) { post({ type: 'size-done', taskId, itemId, bytes, files, denied, cancelled: true }); return; }
        const now = Date.now();
        if (now - lastPost > 200) { lastPost = now; report(false); }
      }
    }
  }
  report(true);
}

// ---------------------------------------------------------------- walk ----
// Finds: project build artifacts (by rule), large files, .apk/.aab/.ipa
// binaries, installer files in ~/Downloads, gradle-wrapper/ndkVersion pins.
// Never descends into: claimed paths, matched artifacts, dot-dirs (unless a
// rule matches them), symlinks.

function walkTask(task) {
  const { taskId, root, depth, config } = task;
  const { maxDepth, fanoutDepth, claimed, rules, prefixRules, largeFileMin, binaryExts, binaryMin, installerExts, installerMin, downloadsDir, home, dupMin } = config;
  const claimedSet = new Set(claimed);
  const rulesByName = new Map(rules.map(r => [r.dir, r]));
  let lastStatus = 0;
  let denied = 0;
  // duplicate candidates: (path,size,mtime) batched to the parent, which
  // size-groups across ALL walk tasks and schedules hashing
  let dupBatch = [];
  const flushDups = () => { if (dupBatch.length) { post({ type: 'dup-candidates', files: dupBatch }); dupBatch = []; } };

  const stack = [{ dir: root, depth }];
  while (stack.length) {
    if (isCancelled()) break;
    const { dir, depth: d } = stack.pop();
    const now = Date.now();
    if (now - lastStatus > 300) { lastStatus = now; post({ type: 'walk-status', taskId, dir }); }

    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { denied++; continue; }
    const names = new Set(ents.map(e => e.name));

    for (const ent of ents) {
      if (isCancelled()) break;
      const p = dir + '/' + ent.name;
      if (claimedSet.has(p)) continue;

      if (ent.isSymbolicLink()) continue;

      if (ent.isDirectory()) {
        const rule = matchRule(ent.name, names, rulesByName, prefixRules);
        if (rule) {
          let parentMtime = 0;
          try { parentMtime = fs.statSync(dir).mtimeMs; } catch {}
          post({ type: 'found-artifact', taskId, path: p, rule: rule.dir || rule.prefix, safety: rule.safety, why: rule.why, regen: rule.regen, project: dir, parentMtime });
          continue; // never descend into a matched artifact
        }
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue; // unmatched dot-dirs skipped
        if (d + 1 >= maxDepth) continue;
        if (d + 1 <= fanoutDepth) {
          post({ type: 'walk-subtask', taskId, dir: p, depth: d + 1 });
        } else {
          stack.push({ dir: p, depth: d + 1 });
        }
        continue;
      }

      // ---- files ----
      if (ent.name === 'gradle-wrapper.properties') {
        const v = readGradlePin(p);
        if (v) post({ type: 'gradle-pin', version: v, project: projectRootFromWrapper(p) });
        continue;
      }
      if (ent.name === 'build.gradle' || ent.name === 'build.gradle.kts') {
        for (const v of readNdkPins(p)) post({ type: 'ndk-pin', version: v, project: dir });
        // fall through — gradle files are tiny, no size interest
      }

      const ext = extOf(ent.name);
      const wantBinary = binaryExts.includes(ext);
      const inDownloads = dir === downloadsDir || dir.startsWith(downloadsDir + '/');
      const wantInstaller = inDownloads && installerExts.includes(ext);
      // lstat every file: needed for large-file detection anyway
      let st;
      try { st = fs.lstatSync(p); } catch { denied++; continue; }
      const size = st.blocks * 512;
      if (size >= largeFileMin) {
        post({ type: 'found-file', taskId, kind: 'large', path: p, bytes: size, mtime: st.mtimeMs, inDownloads });
      } else if (wantBinary && size >= binaryMin) {
        post({ type: 'found-file', taskId, kind: 'binary', path: p, bytes: size, mtime: st.mtimeMs });
      } else if (wantInstaller && size >= installerMin) {
        post({ type: 'found-file', taskId, kind: 'installer', path: p, bytes: size, mtime: st.mtimeMs });
      }
      if (dupMin && st.size >= dupMin) {
        dupBatch.push({ path: p, size: st.size, mtime: st.mtimeMs });
        if (dupBatch.length >= 500) flushDups();
      }
    }
  }
  flushDups();
  post({ type: 'walk-done', taskId, denied });
}

// ---------------------------------------------------------- media walk ----
// Movies/Music/Pictures: excluded from the main walk (no build artifacts
// there) but exactly where a normal user's biggest files live. Reports big
// files and duplicate candidates; never descends into library packages
// (Photos/Music libraries are opaque bundles — touching files inside corrupts
// them), and reports each package's total as a display-only "big file".

function mediaWalkTask(task) {
  const { taskId, root, config } = task;
  const { largeFileMin, dupMin, packageSkips } = config;
  let denied = 0;
  let lastStatus = 0;
  let dupBatch = [];
  const flushDups = () => { if (dupBatch.length) { post({ type: 'dup-candidates', files: dupBatch }); dupBatch = []; } };
  const isPackage = (name) => { const l = name.toLowerCase(); return packageSkips.some(x => l.endsWith(x)); };

  const stack = [root];
  while (stack.length) {
    if (isCancelled()) break;
    const dir = stack.pop();
    const now = Date.now();
    if (now - lastStatus > 300) { lastStatus = now; post({ type: 'walk-status', taskId, dir }); }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { denied++; continue; }
    for (const ent of ents) {
      if (isCancelled()) break;
      const p = dir + '/' + ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (isPackage(ent.name)) {
          post({ type: 'found-package', taskId, path: p });
          continue;
        }
        if (ent.name.startsWith('.')) continue;
        stack.push(p);
        continue;
      }
      let st;
      try { st = fs.lstatSync(p); } catch { denied++; continue; }
      const size = st.blocks * 512;
      if (size >= largeFileMin) {
        post({ type: 'found-file', taskId, kind: 'large', path: p, bytes: size, mtime: st.mtimeMs, media: true });
      }
      if (dupMin && st.size >= dupMin) {
        dupBatch.push({ path: p, size: st.size, mtime: st.mtimeMs });
        if (dupBatch.length >= 500) flushDups();
      }
    }
  }
  flushDups();
  post({ type: 'walk-done', taskId, denied });
}

// ---------------------------------------------------------------- hash ----
// Duplicate confirmation: same byte size AND same sampled digest. The sample
// (first 256 KB + last 64 KB + total length) is effectively collision-proof
// for the "same file copied around" case while staying fast on video files.

function hashTask({ taskId, files }) {
  for (const f of files) {
    if (isCancelled()) break;
    let fd;
    try {
      fd = fs.openSync(f.path, 'r');
      const st = fs.fstatSync(fd);
      if (st.size !== f.size) { fs.closeSync(fd); continue; } // changed since scan
      const hash = crypto.createHash('sha1');
      const head = Buffer.alloc(Math.min(256 * 1024, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      hash.update(head);
      if (st.size > head.length) {
        const tail = Buffer.alloc(Math.min(64 * 1024, st.size - head.length));
        fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
        hash.update(tail);
      }
      fs.closeSync(fd);
      post({ type: 'hash-result', taskId, path: f.path, size: f.size, mtime: f.mtime, hash: hash.digest('hex') });
    } catch {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }
}

function matchRule(name, siblingNames, rulesByName, prefixRules) {
  let rule = rulesByName.get(name);
  if (!rule) {
    for (const pr of prefixRules) if (name.startsWith(pr.prefix)) { rule = pr; break; }
  }
  if (!rule) return null;
  if (rule.siblings && !rule.siblings.some(s => siblingNames.has(s))) return null;
  return rule;
}

function extOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  return path.extname(lower);
}

function readGradlePin(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/distributionUrl=.*gradle-([\d.]+)-(?:bin|all)\.zip/);
    return m ? m[1] : null;
  } catch { return null; }
}

function projectRootFromWrapper(p) {
  // <project>/gradle/wrapper/gradle-wrapper.properties
  return path.dirname(path.dirname(path.dirname(p)));
}

function readNdkPins(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 512 * 1024) return [];
    const txt = fs.readFileSync(file, 'utf8');
    const out = [];
    const re = /ndkVersion\s*[=(]?\s*["']([\d.]+)["']/g;
    let m;
    while ((m = re.exec(txt))) out.push(m[1]);
    return out;
  } catch { return []; }
}
