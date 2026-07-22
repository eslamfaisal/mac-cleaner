# Mac Cleaner

A local, zero-dependency web dashboard that scans your Mac for cleanable developer
junk — Xcode/iOS build artifacts, Android/Gradle caches, Flutter/Dart caches, npm/pnpm/yarn
stores, Python/Go/Rust/Ruby package caches, Docker/VM disks, IDE caches, project build
output (`node_modules`, `build`, `.next`, `Pods`, …), large files, stray `.apk`/`.aab`/`.ipa`
binaries, and installer leftovers in `Downloads` — classifies each by safety, and lets you
delete manually while the scan streams results live over Server-Sent Events.

Nothing is ever deleted automatically. You decide what goes.

## Why

Developer machines quietly fill up with gigabytes of regenerable cache: Xcode `DerivedData`,
Gradle version caches, CocoaPods, `node_modules` scattered across old projects, orphaned
iOS Simulators, stale Docker images. Mac Cleaner scans all of it in one pass, tells you what
is safe to remove and why, cross-references pinned versions in your actual projects
(`gradle-wrapper.properties`, `ndkVersion`) so it doesn't suggest deleting something you still
need, and gets out of the way for anything it can't safely automate (root-owned system
caches, `docker system prune`, `simctl`) by surfacing the exact terminal command instead.

## Features

- **Fast, parallel scanning** — a worker-thread pool (sized to your CPU) walks your home
  directory and sizes directories concurrently; results stream in live, no waiting for a
  full scan to finish before you start reviewing.
- **Safety-classified** — every item is `safe` (pure cache, regenerates silently), `caution`
  (re-downloadable/rebuildable, costs time or bandwidth), or `risky` (potential real data
  loss — device backups, Xcode archives, VM disks, call/meeting recordings). Hover any row
  to see *why* it's cleanable and *how it comes back*.
- **Smart cross-checks**:
  - Orphaned iOS Simulators (runtime deleted, device unusable) via `simctl`.
  - Gradle cache versions and wrapper distributions flagged as *pinned* when a real
    project's `gradle-wrapper.properties` still targets that version.
  - NDK versions flagged as *pinned* when a project's `build.gradle(.kts)` sets that
    `ndkVersion`.
  - Android Studio profile versions marked *current* vs *old* by version compare.
  - Android emulators (AVDs) split into "wipe user data" vs "delete entire emulator."
  - Recently-touched project directories (mtime < 30 days) get an **active project** badge
    so you don't nuke something you're mid-way through.
- **Project build-artifact walker** — recognizes `node_modules`, `build`, `dist`, `.next`,
  `.nuxt`, `.turbo`, `Pods`, `target`, `.venv`, `__pycache__`, `.terraform`, and ~25 other
  patterns, gated on sibling files (e.g. `build/` only counts next to `pubspec.yaml` /
  `gradlew` / `package.json` / etc.) to avoid false positives on generically-named folders.
- **Large files & binaries** — flags files ≥ 500 MB anywhere in your home directory, and
  `.apk` / `.aab` / `.ipa` binaries ≥ 5 MB (built artifacts inside build output are
  distinguished from possibly-archived releases sitting elsewhere).
- **Manual, granular deletion** — per item, a selected set, or "select all safe." Two modes:
  **move to Trash** (restorable) or **delete permanently**. Root-owned locations are shown
  read-only with the equivalent terminal command instead of a broken delete button.
- **Live disk gauge** — total/free space and reclaimed-so-far, updated after every delete.
- **Suggested terminal commands** — for things a web UI shouldn't touch directly: Homebrew
  cleanup, `docker system prune`, orphaned simulator/runtime deletion, Time Machine local
  snapshots, Go module cache, Conda, CocoaPods.

## Run

Requires Node.js (built-ins only — no `npm install` needed).

```sh
npm start
# → http://127.0.0.1:4545
```

Grant **Full Disk Access** to your terminal app (System Settings → Privacy & Security →
Full Disk Access) for complete results — a few locations (Safari cache, device backups,
some container data) are unreadable without it. The dashboard detects this and offers a
one-click deep link to the right settings pane.

## Safety model

| Level | Meaning |
|---|---|
| `safe` | Pure cache, regenerated automatically. Costs nothing but a slightly slower next run. |
| `caution` | Re-downloadable / rebuildable, but costs time or bandwidth (or minor state loss). |
| `risky` | Potential data loss (device backups, VM disks, recordings, Xcode archives). Requires explicit acknowledgment before delete. |

## Security model

The server can delete files on your machine, so it is deliberately strict:

- Binds `127.0.0.1` only — never reachable from the network.
- `Host` header must be `localhost`/`127.0.0.1` on that port (DNS-rebinding defense).
- `Origin` header, when present, must match this server (CSRF defense).
- Every `POST` requires a per-boot random token, injected server-side into the served HTML —
  no other page or script can forge a delete request.
- Only paths the scanner itself registered can be deleted, and only after a validation
  chain: realpath resolution, allow-listed roots, an exact-match banned-paths set (home dir,
  `Desktop`, `Documents`, `Library`, `Keychains`, `Preferences`, …), a minimum path depth, and
  a symlink check at delete time (defends against a path being swapped after the scan
  completed — TOCTOU).

## Project structure

```
server.js          HTTP server: static files, SSE event stream, delete pipeline, security checks
lib/categories.js   Declarative catalog of every cleanable location + safety metadata
lib/scanner.js       Scan orchestrator: worker pool, item registry, dedup, cross-references
lib/worker.js        Worker thread: directory sizing + home-directory artifact walk
public/              Static frontend (vanilla HTML/CSS/JS, no build step)
```

### How a scan works

1. `server.js` boots a `Scanner`, which spins up a pool of worker threads (`os.cpus() - 2`,
   clamped 2–8).
2. Every location in `lib/categories.js` is registered; each becomes an "item" with a unique
   id, sized by a worker task. Registration order matters — earlier, more specific entries
   claim their paths first so later generic sweeps (e.g. "all of `~/Library/Caches`") skip
   anything already accounted for.
3. In parallel, a home-directory walk (`lib/worker.js`) looks for project build artifacts,
   large files, stray binaries, and installers, fanning out into parallel subtasks for the
   first couple of directory levels.
4. Results stream to the browser over `/api/events` (SSE), coalesced to ~10 Hz so the tab
   never floods; a plain `GET /api/state` gives a point-in-time snapshot.
5. Deleting posts to `/api/delete` with a list of item ids and a mode (`trash` / permanent);
   deletions run with bounded concurrency and re-validate every path immediately before
   touching disk.

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/state` | GET | Full snapshot of current scan state |
| `/api/events` | GET | SSE stream of live scan/delete progress |
| `/api/scan/start` | POST | Start (or restart) a scan |
| `/api/scan/cancel` | POST | Cancel the in-progress scan |
| `/api/delete` | POST | Delete/trash a set of item ids: `{ ids: string[], mode: 'trash' \| 'rm' }` |
| `/api/reveal` | POST | Reveal an item in Finder |
| `/api/settings/fda` | POST | Deep-link to the Full Disk Access settings pane |

All `POST` requests require the `x-token` header (the per-boot token embedded in the served
page) — the API is not meant to be called from anywhere but the bundled frontend.

## License

Personal utility, provided as-is — no warranty. Use at your own risk; always double-check
what you're about to delete, especially anything marked `risky`.
