// Local-only HTTP server: static UI, SSE event stream, delete pipeline.
//
// Security model (this server can delete files, so it is deliberately strict):
//  - binds 127.0.0.1 only
//  - Host header must be localhost/127.0.0.1 (DNS-rebinding defense)
//  - Origin header, when present, must match this server (CSRF defense)
//  - all POSTs require a per-boot random token injected into the served HTML
//  - only items registered by the scanner can be deleted, after a validation
//    chain (realpath match, allowed roots, banned paths, minimum depth)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Scanner, GROUPS, HOME } from './lib/scanner.js';
import { SUGGESTED_COMMANDS } from './lib/categories.js';

// PORT=0 asks the OS for an ephemeral port (used by the .app wrapper, which
// reads the LISTENING line from stdout). boundPort is the real port once bound.
const PORT = Number(process.env.PORT ?? 4545);
let boundPort = PORT;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const TOKEN = crypto.randomBytes(16).toString('hex');
const BOOT_ID = crypto.randomBytes(8).toString('hex');
let APP_VERSION = 'dev';
try { APP_VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch {}

const scanner = new Scanner();
let reclaimedBytes = 0;
let disk = null;

// ------------------------------------------------------------- SSE hub ----

const sseClients = new Set();
let dirtyItems = new Map();
let dirtyFlags = { progress: false, scan: false, disk: false, reclaimed: false };
let walkStatusDir = null;

function sseSend(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      if (!res.write(payload)) { res.end(); sseClients.delete(res); }
    } catch { sseClients.delete(res); }
  }
}

// Coalesce item/progress updates to ~10 Hz so the tab never floods.
setInterval(() => {
  if (dirtyItems.size) {
    broadcast('items', [...dirtyItems.values()].map(publicItem));
    dirtyItems = new Map();
  }
  if (dirtyFlags.progress) { broadcast('progress', scanner.state()); dirtyFlags.progress = false; }
  if (dirtyFlags.scan) { broadcast('scan', scanner.state()); dirtyFlags.scan = false; }
  if (walkStatusDir) { broadcast('walk', { dir: walkStatusDir.startsWith(HOME) ? '~' + walkStatusDir.slice(HOME.length) : walkStatusDir }); walkStatusDir = null; }
  if (dirtyFlags.reclaimed) { broadcast('reclaimed', { bytes: reclaimedBytes }); dirtyFlags.reclaimed = false; }
  if (dirtyFlags.disk) { broadcast('disk', disk); dirtyFlags.disk = false; }
}, 100);

setInterval(() => broadcast('ping', {}), 15000);

scanner.on('item', (item) => { dirtyItems.set(item.id, item); });
scanner.on('progress', () => { dirtyFlags.progress = true; });
scanner.on('scan-status', () => { dirtyFlags.scan = true; });
scanner.on('walk-status', (dir) => { walkStatusDir = dir; });
scanner.on('done', () => { dirtyFlags.scan = true; refreshDisk(); });

function publicItem(i) {
  return {
    id: i.id, group: i.group, name: i.name, display: i.display, safety: i.safety,
    why: i.why, regen: i.regen, kind: i.kind, deleteMode: i.deleteMode,
    permanentOnly: i.permanentOnly, displayOnly: i.displayOnly, needs: i.needs || null, badges: i.badges,
    status: i.status, bytes: i.bytes, files: i.files, denied: i.denied,
    error: i.error || null, mtime: i.mtime || null,
    project: i.project ? (i.project.startsWith(HOME) ? '~' + i.project.slice(HOME.length) : i.project) : null,
    projectName: i.projectName || null,
    dupNewest: !!i.dupNewest,
    noTotal: !!i.noTotal,
  };
}

function snapshot() {
  return {
    groups: GROUPS,
    items: [...scanner.items.values()].map(publicItem),
    scan: scanner.state(),
    disk,
    reclaimed: reclaimedBytes,
    commands: SUGGESTED_COMMANDS,
    home: HOME,
    bootId: BOOT_ID,
    fda: fdaGranted(),
    appMode: !!process.env.APP_MODE,
    version: APP_VERSION,
  };
}

// ------------------------------------------------------------- FDA --------

// macOS has no programmatic prompt for Full Disk Access — the best an app can
// do is detect it's missing and deep-link the user to the settings pane.
// Several probe paths reduce false negatives on machines without Safari data.
const FDA_PROBES = [
  path.join(HOME, 'Library/Safari'),
  path.join(HOME, 'Library/Mail'),
  path.join(HOME, 'Library/Application Support/MobileSync/Backup'),
];

function fdaGranted() {
  let sawDenied = false;
  for (const p of FDA_PROBES) {
    try { fs.readdirSync(p); return true; }
    catch (e) { if (e.code !== 'ENOENT') sawDenied = true; }
  }
  return !sawDenied; // every probe absent = can't tell, assume fine
}

// Live re-probe: the settings pane grant takes effect for this running
// process, so the UI pill can flip to "granted" without a restart.
let fdaLast = null;
setInterval(() => {
  const g = fdaGranted();
  if (g !== fdaLast) { fdaLast = g; broadcast('fda', { granted: g }); }
}, 3000);

// ------------------------------------------------------------- disk -------

async function refreshDisk() {
  for (const vol of ['/System/Volumes/Data', '/']) {
    try {
      const s = await fsp.statfs(vol);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, vol };
      dirtyFlags.disk = true;
      return;
    } catch {}
  }
}

// ------------------------------------------------------ delete pipeline ---

const BANNED_EXACT = new Set([
  '/', '/System', '/Library', '/Users', '/Applications', '/private', '/var', '/etc', '/usr', '/bin', '/opt',
  HOME,
  path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads'),
  path.join(HOME, 'Pictures'), path.join(HOME, 'Movies'), path.join(HOME, 'Music'),
  path.join(HOME, 'Library'), path.join(HOME, 'Library/Application Support'),
  path.join(HOME, 'Library/Caches'), path.join(HOME, 'Library/Developer'),
  path.join(HOME, 'Library/Keychains'), path.join(HOME, 'Library/Preferences'),
]);
const ALLOWED_ROOTS = [HOME + '/', '/Library/Caches/', '/Library/Logs/'];

function validateDeletablePath(p) {
  // Throws with a reason when the path must not be deleted.
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('invalid path');
  const norm = path.normalize(p);
  if (norm.includes('..')) throw new Error('invalid path');
  if (BANNED_EXACT.has(norm)) throw new Error('protected path');
  if (!ALLOWED_ROOTS.some(r => norm.startsWith(r))) throw new Error('outside allowed roots');
  if (norm.split('/').filter(Boolean).length < 3) throw new Error('path too shallow');
  // Keychains / Preferences must never be reachable even via subpaths
  for (const banned of ['/Library/Keychains/', '/Library/Preferences/']) {
    if (norm.startsWith(HOME + banned)) throw new Error('protected path');
  }
  return norm;
}

function validateItemForDelete(item) {
  if (!item) throw new Error('unknown item');
  if (item.displayOnly) throw new Error('item is display-only (root-owned)');
  if (['deleting', 'deleted', 'gone', 'missing'].includes(item.status)) throw new Error('item already ' + item.status);
  const targets = item.kind === 'files' ? item.paths : [item.path];
  for (const t of targets) {
    validateDeletablePath(t);
    // symlink-swap defense applies to every target, incl. kind 'files'
    const st = fs.lstatSync(t); // throws if missing
    if (st.isSymbolicLink()) throw new Error('target is a symlink');
  }
  if (item.kind !== 'files') {
    // TOCTOU defense: the path must still resolve to what we registered,
    // and the resolved path must itself sit inside the allowed roots
    // (a symlinked parent must not move the delete outside them).
    const real = fs.realpathSync(item.path);
    if (real !== item.real) throw new Error('path changed since scan — rescan first');
    validateDeletablePath(real);
  }
  if (item.extraDelete) for (const t of item.extraDelete) validateDeletablePath(t);
  return true;
}

const deleteQueue = [];
let deleting = 0;

function enqueueDelete(ids, mode) {
  const accepted = [];
  for (const id of ids) {
    const item = scanner.items.get(id);
    if (!item || item.displayOnly || ['deleting', 'deleted', 'gone', 'missing'].includes(item.status)) continue;
    item.status = 'queued';
    dirtyItems.set(item.id, item);
    deleteQueue.push({ item, mode });
    accepted.push(id);
  }
  pumpDeletes();
  return accepted;
}

function pumpDeletes() {
  while (deleting < 2 && deleteQueue.length) {
    const job = deleteQueue.shift();
    deleting++;
    runDelete(job).finally(() => { deleting--; pumpDeletes(); });
  }
}

async function runDelete({ item, mode }) {
  try {
    validateItemForDelete(item);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // vanished between scan and delete (e.g. a build regenerated) — that's
      // not an error, the space is simply no longer there to reclaim
      scanner.markGone(item.id);
    } else {
      scanner.markDeleted(item.id, false, friendlyError(e));
    }
    return;
  }
  scanner.markDeleting(item.id);
  try {
    if (mode === 'trash' && !item.permanentOnly) {
      await moveToTrash(item);
    } else {
      await permanentDelete(item);
    }
    reclaimedBytes += item.bytes || 0;
    dirtyFlags.reclaimed = true;
    scanner.markDeleted(item.id, true);
    refreshDisk();
  } catch (e) {
    scanner.markDeleted(item.id, false, friendlyError(e));
  }
}

async function listDeleteTargets(item) {
  if (item.kind === 'files') return [...item.paths, ...(item.extraDelete || [])];
  if (item.deleteMode === 'contents') {
    // re-assert right before the readdir that the dir wasn't swapped for a
    // symlink after validation (TOCTOU on the contents enumeration)
    const st = fs.lstatSync(item.path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('target changed since validation');
    if (fs.realpathSync(item.path) !== item.real) throw new Error('path changed since scan — rescan first');
    let names = await fsp.readdir(item.path);
    // e.g. JetBrains LocalHistory — recovery data carved out of a cache sweep
    if (item.contentsExclude) names = names.filter(n => !item.contentsExclude.includes(n));
    return names.map(n => path.join(item.path, n));
  }
  return [item.path, ...(item.extraDelete || [])];
}

async function permanentDelete(item) {
  const targets = await listDeleteTargets(item);
  for (const t of targets) {
    validateDeletablePath(t);
    try {
      await fsp.rm(t, { recursive: true, force: true, maxRetries: 2 });
    } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM') {
        // read-only trees (Go module cache): make writable, retry once
        await new Promise((res) => execFile('/bin/chmod', ['-R', 'u+w', t], { timeout: 120000 }, () => res()));
        await fsp.rm(t, { recursive: true, force: true, maxRetries: 2 });
      } else throw e;
    }
  }
}

let trashSeq = 0;
const trashReserved = new Set(); // dest names claimed by in-flight jobs

async function moveToTrash(item) {
  const trash = path.join(HOME, '.Trash');
  const targets = await listDeleteTargets(item);
  for (const t of targets) {
    validateDeletablePath(t);
    // Two concurrent jobs trashing files with the same basename must never
    // resolve the same dest — rename over an existing file is a silent
    // overwrite. Reservation is SYNCHRONOUS (no await between check and add)
    // so concurrent jobs can't both claim the base name; the per-boot seq
    // suffix is unique, so only the base name needs an on-disk check.
    const reserve = () => {
      let d = path.join(trash, path.basename(t));
      if (trashReserved.has(d)) d = path.join(trash, `${path.basename(t)} ${Date.now()}-${++trashSeq}`);
      trashReserved.add(d);
      return d;
    };
    let dest = reserve();
    try { await fsp.access(dest); dest = reserve(); } catch { /* free */ }
    try {
      await fsp.rename(t, dest);
    } catch (e) {
      if (e.code === 'EXDEV') throw new Error('different volume — use permanent delete for this item');
      if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
        const retry = path.join(trash, `${path.basename(t)} ${Date.now()}-${++trashSeq}`);
        trashReserved.add(retry);
        await fsp.rename(t, retry);
      } else throw e;
    }
  }
}

function friendlyError(e) {
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'Permission denied — may need Full Disk Access or admin rights';
  if (e.code === 'ENOENT') return 'Already gone';
  if (e.code === 'EBUSY') return 'File is in use';
  return e.message || String(e);
}

// ------------------------------------------------------------- HTTP -------

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', token: true },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

function hostOk(req) {
  const host = String(req.headers.host || '');
  return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (!hostOk(req) || !originOk(req)) { json(res, 403, { error: 'forbidden' }); return; }
  const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);

  // ---- static ----
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const s = STATIC[url.pathname];
    try {
      let body = await fsp.readFile(path.join(PUB, s.file), 'utf8');
      if (s.token) body = body.replace('__TOKEN__', TOKEN);
      res.writeHead(200, { 'content-type': s.type, 'cache-control': 'no-store' });
      res.end(body);
    } catch { json(res, 500, { error: 'missing asset' }); }
    return;
  }

  // ---- SSE ----
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sseClients.add(res);
    sseSend(res, 'hello', snapshot());
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, snapshot());
    return;
  }

  // ---- POSTs (token-gated) ----
  if (req.method === 'POST') {
    if (req.headers['x-token'] !== TOKEN) { json(res, 403, { error: 'bad token' }); return; }
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { error: e.message }); return; }

    switch (url.pathname) {
      case '/api/scan/start':
        scanner.startScan();
        refreshDisk();
        broadcast('fda', { granted: fdaGranted() });
        json(res, 200, { ok: true });
        return;
      case '/api/settings/fda':
        // deep-link to System Settings → Privacy & Security → Full Disk Access
        execFile('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { timeout: 5000 }, () => {});
        json(res, 200, { ok: true });
        return;
      case '/api/scan/cancel':
        scanner.cancelScan();
        json(res, 200, { ok: true });
        return;
      case '/api/delete': {
        if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 5000) {
          json(res, 400, { error: 'ids required' }); return;
        }
        const mode = body.mode === 'trash' ? 'trash' : 'rm';
        const accepted = enqueueDelete(body.ids.map(String), mode);
        json(res, 200, { ok: true, accepted });
        return;
      }
      case '/api/reveal': {
        const item = scanner.items.get(String(body.id || ''));
        if (!item) { json(res, 404, { error: 'unknown item' }); return; }
        const target = item.kind === 'files' ? item.paths[0] : item.path;
        execFile('/usr/bin/open', ['-R', target], { timeout: 5000 }, () => {});
        json(res, 200, { ok: true });
        return;
      }
      default:
        json(res, 404, { error: 'not found' });
        return;
    }
  }

  json(res, 404, { error: 'not found' });
});

refreshDisk();
server.listen(PORT, '127.0.0.1', () => {
  boundPort = server.address().port;
  console.log(`LISTENING ${boundPort}`);
  console.log(`Mac Cleaner dashboard → http://127.0.0.1:${boundPort}`);
  console.log(`Grant Full Disk Access to your terminal for complete results.`);
});
