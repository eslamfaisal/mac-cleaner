// Declarative catalog of cleanable locations on a macOS developer machine.
// Safety levels:
//   safe    — pure cache, regenerated automatically; deleting costs nothing but a slower next run
//   caution — re-downloadable/rebuildable, but costs time/bandwidth (or minor state loss)
//   risky   — potential data loss; requires explicit acknowledgment in the UI
// kind: 'single' (one item) | 'children' (each direct child dir becomes its own item)
// deleteMode: 'self' (default, rm the dir) | 'contents' (rm entries inside, keep the dir)
// displayOnly: size is reported but deletion is disabled (root-owned paths)

import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
const h = (...p) => path.join(HOME, ...p);
const AS = h('Library', 'Application Support');

export const GROUPS = [
  { id: 'trash', title: 'Trash', icon: '🗑️' },
  { id: 'large', title: 'Biggest Files', icon: '🐋' },
  { id: 'duplicates', title: 'Duplicate Files', icon: '👯' },
  { id: 'personal', title: 'Personal & Media', icon: '🏠' },
  { id: 'applications', title: 'Applications — Old & Unused', icon: '⏳' },
  { id: 'leftovers', title: 'Leftovers from Uninstalled Apps', icon: '👻' },
  { id: 'system-data', title: 'System Data', icon: '🗄️' },
  { id: 'xcode', title: 'Xcode & iOS', icon: '🔨' },
  { id: 'android', title: 'Android & JVM', icon: '🤖' },
  { id: 'flutter', title: 'Flutter & Dart', icon: '🐦' },
  { id: 'node', title: 'JavaScript & Node', icon: '📦' },
  { id: 'python', title: 'Python', icon: '🐍' },
  { id: 'langs', title: 'Go · Rust · Other Languages', icon: '⚙️' },
  { id: 'games', title: 'Games & Game Engines', icon: '🎮' },
  { id: 'creative', title: 'Creative — Video · Photo · Audio · Design', icon: '🎬' },
  { id: 'docker', title: 'Docker & VMs', icon: '🐳' },
  { id: 'ide', title: 'IDEs & Editors', icon: '💻' },
  { id: 'browsers', title: 'Browsers', icon: '🌐' },
  { id: 'apps', title: 'App Caches & Data', icon: '💬' },
  { id: 'ai', title: 'AI & ML', icon: '🧠' },
  { id: 'backups', title: 'Device Backups', icon: '📱' },
  { id: 'caches-user', title: 'User App Caches', icon: '🧹' },
  { id: 'caches-system', title: 'System Caches & Logs', icon: '🖥️' },
  { id: 'projects', title: 'Project Build Artifacts', icon: '🏗️' },
  { id: 'binaries', title: 'App Binaries (.apk / .aab / .ipa)', icon: '📲' },
  { id: 'installers', title: 'Installers & Disk Images', icon: '💿' },
];

// ---------------------------------------------------------------------------
// Normal-user taxonomy. Same items, regrouped into plain-language categories
// for people who never open a terminal. Ids are prefixed 'n-' so they can
// never collide with a dev group id (hash routes, cluster rules, colors).
// Order = display order on the overview.
export const NORMAL_GROUPS = [
  { id: 'n-junk', title: 'System Junk', icon: '🧹',
    desc: 'Caches, logs and temporary files your Mac and your apps rebuild by themselves.' },
  { id: 'n-trash', title: 'Trash', icon: '🗑️',
    desc: 'Files you already deleted. They still take up space until the Trash is emptied.' },
  { id: 'n-large', title: 'Large & Old Files', icon: '🐋',
    desc: 'The biggest files on your Mac, and the ones you have not changed in a long time.' },
  { id: 'n-dups', title: 'Duplicate Files', icon: '👯',
    desc: 'The same file saved more than once. Keep one copy, remove the rest.' },
  { id: 'n-downloads', title: 'Downloads & Installers', icon: '💿',
    desc: 'Old app installers, disk images and downloads you never went back to.' },
  { id: 'n-apps', title: 'Unused Apps & Leftovers', icon: '⏳',
    desc: 'Apps you stopped opening, older copies of apps, and data left behind by apps you removed.' },
  { id: 'n-appdata', title: 'App Caches', icon: '💬',
    desc: 'Space taken by Spotify, WhatsApp, Zoom, Office, Slack and other everyday apps.' },
  { id: 'n-mail', title: 'Mail & Message Attachments', icon: '📎',
    desc: 'Attachment copies from Mail (the originals stay in your email) and the photos and videos people sent you in Messages.' },
  { id: 'n-media', title: 'Photos, Music & Media', icon: '🖼️',
    desc: 'Downloaded podcasts and books, photo caches and screenshots piling up.' },
  { id: 'n-backups', title: 'Backups & Updates', icon: '📱',
    desc: 'iPhone and iPad backups, plus installer files macOS downloaded for updates.' },
  { id: 'n-cloud', title: 'Cloud Files on This Mac', icon: '☁️',
    desc: 'iCloud Drive, Dropbox, Google Drive and OneDrive files kept on the disk. They also live in the cloud — freeing them is done from Finder, not here.' },
  { id: 'n-dev', title: 'Developer & Pro Tools', icon: '🛠️',
    desc: 'Xcode, Android, npm, Docker, video and design tool caches — everything technical, in one place.' },
];

// Default dev group → normal group. Individual targets can override this with
// a `normalGroup` field (see buildStaticTargets); anything unmapped falls back
// to the collapsed developer card.
export const DEV_TO_NORMAL = {
  trash: 'n-trash',
  large: 'n-large',
  duplicates: 'n-dups',
  installers: 'n-downloads',
  applications: 'n-apps',
  leftovers: 'n-apps',
  apps: 'n-appdata',
  personal: 'n-media',
  backups: 'n-backups',
  'system-data': 'n-junk',
  'caches-user': 'n-junk',
  'caches-system': 'n-junk',
  browsers: 'n-junk',
  // technical groups collapse into one card for normal users
  xcode: 'n-dev', android: 'n-dev', flutter: 'n-dev', node: 'n-dev',
  python: 'n-dev', langs: 'n-dev', docker: 'n-dev', ide: 'n-dev',
  ai: 'n-dev', projects: 'n-dev', binaries: 'n-dev', games: 'n-dev',
  creative: 'n-dev',
};

export const NORMAL_FALLBACK_GROUP = 'n-dev';

// Registration order matters: earlier entries claim their paths first; later
// generic enumerators (User App Caches, Electron sweep) skip claimed paths.
export function buildStaticTargets() {
  const T = (group, name, p, safety, why, regen, opts = {}) =>
    ({ group, name, path: p, safety, why, regen, kind: 'single', ...opts });

  return [
    // ---- Trash ----
    T('trash', 'Trash', h('.Trash'), 'safe',
      'Files you already deleted. Emptying frees the space permanently.',
      'Nothing comes back — this is the final delete.',
      { deleteMode: 'contents', permanentOnly: true }),

    // ---- Personal & Media (for every Mac user, not just developers) ----
    T('personal', 'Mail attachment copies', h('Library/Containers/com.apple.mail/Data/Library/Mail Downloads'), 'safe',
      'Copies of attachments you opened from Mail. The originals stay inside the emails.',
      'Re-created when you open an attachment again.',
      { needs: 'fda', normalGroup: 'n-mail' }),
    T('personal', 'Mail attachment copies (legacy)', h('Library/Mail Downloads'), 'safe',
      'Attachment copies from older macOS Mail versions. Originals stay in the emails.',
      'Re-created when you open an attachment again.',
      { needs: 'fda', normalGroup: 'n-mail' }),
    // The mail store itself is never deletable from here (server.js bans it),
    // but leaving it invisible made a category called "Mail & Message
    // Attachments" report a few hundred MB while Mail quietly held 20 GB.
    T('personal', 'Mail — downloaded messages', h('Library/Mail'), 'caution',
      'Every message and attachment Mail has downloaded for offline use. This is your mail, not a cache.',
      'Free space from inside Mail: Mailbox ▸ Erase Deleted Items, empty Junk, or turn off “Download attachments” in Account Settings.',
      { displayOnly: true, needs: 'fda', normalGroup: 'n-mail' }),
    T('personal', 'Screensaver & wallpaper videos', '/Library/Application Support/com.apple.idleassetsd/Customer', 'caution',
      'The 4K aerial videos macOS downloads for its screen savers and moving wallpapers — often tens of GB, and root-owned so they cannot be removed from here.',
      'Re-downloaded by macOS when you pick that screen saver again. To remove them: System Settings → Screen Saver, or delete the folder with sudo.',
      { displayOnly: true, needs: 'root', normalGroup: 'n-media' }),
    T('personal', 'Podcast downloads', h('Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Library/Cache'), 'caution',
      'Episodes downloaded by the Podcasts app — often auto-downloaded and never played.',
      'Any episode re-downloads in the Podcasts app.'),
    T('personal', 'Apple Books downloads', h('Library/Containers/com.apple.BKAgentService/Data/Documents/iBooks/Books'), 'caution',
      'Books and PDFs downloaded by Apple Books.',
      'Purchases re-download from the Book Store; PDFs you added yourself are gone unless backed up.',
      { needs: 'fda' }),
    T('personal', 'Messages attachments', h('Library/Messages/Attachments'), 'risky',
      'Photos, videos and files received in iMessage. Deleting removes them from your chats on this Mac.',
      'Re-downloads only if Messages in iCloud is on and the messages still exist.',
      { needs: 'fda', normalGroup: 'n-mail' }),

    // ---- System Data (the "System Data" bucket in macOS Storage settings) --
    // Deletable entries live under HOME (or /Library/Logs, already an allowed
    // root). Everything macOS manages itself is displayOnly: shown so the
    // user understands where System Data goes, never deletable from here.
    T('system-data', 'iPhone software updates', h('Library/iTunes/iPhone Software Updates'), 'safe',
      'iOS installer files (.ipsw) downloaded when updating a connected iPhone.',
      'Re-downloaded automatically next time a device updates.',
      { normalGroup: 'n-backups' }),
    T('system-data', 'iPad software updates', h('Library/iTunes/iPad Software Updates'), 'safe',
      'iPadOS installer files downloaded during device updates.',
      'Re-downloaded automatically next time a device updates.',
      { normalGroup: 'n-backups' }),
    T('system-data', 'iPod software updates', h('Library/iTunes/iPod Software Updates'), 'safe',
      'iPod software installers.', 'Re-downloaded if ever needed.',
      { normalGroup: 'n-backups' }),
    T('system-data', 'Device restore images', h('Library/MobileDevice/Software Images'), 'safe',
      'Restore/recovery images cached by Finder/Apple Configurator for device restores.',
      'Re-downloaded automatically when a restore needs them.',
      { normalGroup: 'n-backups' }),
    T('system-data', 'Homebrew download cache', h('Library/Caches/Homebrew'), 'safe',
      'Downloaded bottles and old formula versions kept by Homebrew.',
      'brew re-downloads as needed (cleanest via: brew cleanup --prune=all).',
      { normalGroup: 'n-dev' }),
    T('system-data', 'Diagnostic reports (user)', h('Library/Logs/DiagnosticReports'), 'safe',
      'Crash and spin reports for your apps.',
      'New reports are written when apps crash; old ones have no effect.'),
    T('system-data', 'Diagnostic reports (system)', '/Library/Logs/DiagnosticReports', 'caution',
      'System-wide crash reports. Useful only if you are actively debugging a system issue.',
      'New reports are written automatically.'),
    T('system-data', 'macOS update payloads', '/Library/Updates', 'caution',
      'Staged macOS/App Store update payloads. macOS clears this itself after updates install — do not delete it manually.',
      'Managed entirely by macOS.',
      { displayOnly: true, needs: 'root', normalGroup: 'n-backups' }),
    T('system-data', 'macOS installer data', '/macOS Install Data', 'caution',
      'Leftover of an interrupted macOS update. Only remove if a stuck update left it behind (see suggested command).',
      'Software Update recreates it if an update needs it.',
      { displayOnly: true, needs: 'root', normalGroup: 'n-backups' }),
    T('system-data', 'Spotlight index', '/System/Volumes/Data/.Spotlight-V100', 'caution',
      'Search index for this volume. Deleting it directly breaks search — rebuild it with the suggested command instead.',
      'Rebuilt by: sudo mdutil -E / (re-indexing takes a while).',
      { displayOnly: true, needs: 'root' }),
    T('system-data', 'Swap & sleep image', '/System/Volumes/VM', 'caution',
      'Virtual-memory swap and the hibernation image. Part of "System Data" but managed entirely by macOS.',
      'macOS grows and shrinks this on its own — nothing to clean here.',
      { displayOnly: true, needs: 'root' }),

    // ---- Xcode & iOS ----
    T('xcode', 'DerivedData', h('Library/Developer/Xcode/DerivedData'), 'safe',
      'Per-project build intermediates and indexes.',
      'Xcode rebuilds on next build (first build slower).',
      { kind: 'children' }),
    T('xcode', 'Xcode Archives', h('Library/Developer/Xcode/Archives'), 'risky',
      'App archives contain the dSYMs of shipped builds. Deleting loses crash-report symbolication for released versions.',
      'Cannot be regenerated for already-shipped builds.',
      { kind: 'children' }),
    T('xcode', 'iOS DeviceSupport', h('Library/Developer/Xcode/iOS DeviceSupport'), 'safe',
      'Debug symbol sets copied from connected iPhones/iPads.',
      'Regenerates automatically next time the device is connected (takes a few minutes).',
      { kind: 'children' }),
    T('xcode', 'watchOS DeviceSupport', h('Library/Developer/Xcode/watchOS DeviceSupport'), 'safe',
      'Debug symbols from connected watches.', 'Regenerates on device connect.', { kind: 'children' }),
    T('xcode', 'tvOS DeviceSupport', h('Library/Developer/Xcode/tvOS DeviceSupport'), 'safe',
      'Debug symbols from connected Apple TVs.', 'Regenerates on device connect.', { kind: 'children' }),
    T('xcode', 'CoreSimulator caches', h('Library/Developer/CoreSimulator/Caches'), 'safe',
      'Simulator dyld and runtime caches.', 'Rebuilt automatically when simulators boot.'),
    T('xcode', 'CoreSimulator temp', h('Library/Developer/CoreSimulator/Temp'), 'safe',
      'Temporary simulator files.', 'Recreated as needed.'),
    T('xcode', 'Interface Builder simulators', h('Library/Developer/Xcode/UserData/IB Support'), 'safe',
      'Simulators Interface Builder uses to render storyboards.', 'Recreated when IB renders.'),
    T('xcode', 'Simulator devices', h('Library/Developer/CoreSimulator/Devices'), 'caution',
      'Simulator devices and their data. Orphaned devices (runtime deleted) are marked below.',
      'Xcode recreates simulators on demand. Prefer: xcrun simctl delete unavailable. Shut down running simulators first.',
      { kind: 'children', crossRef: 'simctl' }),
    T('xcode', 'XCTestDevices', h('Library/Developer/XCTestDevices'), 'safe',
      'Throwaway simulators created by test runs.', 'Recreated automatically by the test runner.'),
    T('xcode', 'XCPGDevices', h('Library/Developer/XCPGDevices'), 'safe',
      'Playground simulator devices.', 'Recreated when a playground runs.'),
    T('xcode', 'SwiftUI Previews', h('Library/Developer/Xcode/UserData/Previews'), 'safe',
      'Simulators used by SwiftUI previews.', 'Recreated when previews run.'),
    T('xcode', 'DVTDownloads', h('Library/Developer/DVTDownloads'), 'safe',
      'Staging area for simulator runtime downloads.', 'Only needed during a download.'),
    T('xcode', 'Xcode DocumentationCache', h('Library/Developer/Xcode/DocumentationCache'), 'safe',
      'Rendered documentation cache.', 'Rebuilt when docs are opened.'),
    T('xcode', 'iOS Device Logs', h('Library/Developer/Xcode/iOS Device Logs'), 'safe',
      'Console logs collected from devices.', 'New logs collected as you debug.'),
    T('xcode', 'Xcode cache', h('Library/Caches/com.apple.dt.Xcode'), 'safe',
      'Xcode download/index cache.', 'Rebuilt automatically.'),
    T('xcode', 'CoreSimulator logs', h('Library/Logs/CoreSimulator'), 'safe',
      'Per-simulator log files.', 'New logs written as simulators run.'),
    T('xcode', 'App Store upload cache', h('Library/Caches/com.apple.amp.itmstransporter'), 'safe',
      'iTMSTransporter upload cache.', 'Re-created on next App Store upload.'),
    T('xcode', 'iTMSTransporter', h('.itmstransporter'), 'safe',
      'App Store upload tool cache.', 'Re-created on next upload.'),
    T('xcode', 'Simulator runtimes (system)', '/Library/Developer/CoreSimulator/Images', 'caution',
      'Simulator runtime disk images (root-owned — cannot delete from here).',
      'Manage with: xcrun simctl runtime list / xcrun simctl runtime delete <id>.',
      { displayOnly: true }),

    // ---- Android & JVM ----
    T('android', 'Gradle caches', h('.gradle/caches'), 'safe',
      'Per-version Gradle caches. Versions pinned by one of your projects are flagged; modules-2 holds downloaded dependencies.',
      'Gradle re-downloads/rebuilds on next build.',
      { kind: 'children', crossRef: 'gradle-pin' }),
    T('android', 'Gradle daemon logs', h('.gradle/daemon'), 'safe',
      'Old daemon logs.', 'New logs written on next build.'),
    T('android', 'Gradle temp', h('.gradle/.tmp'), 'safe',
      'Gradle temporary files.', 'Recreated as needed.'),
    T('android', 'SDK temp downloads', h('Library/Android/sdk/.temp'), 'safe',
      'SDK Manager temp download area.', 'Only needed during a download.'),
    T('android', 'SDK download intermediates', h('Library/Android/sdk/.downloadIntermediates'), 'safe',
      'Partial SDK downloads.', 'Only needed during a download.'),
    T('android', 'Gradle wrapper distributions', h('.gradle/wrapper/dists'), 'caution',
      'Downloaded Gradle distributions, one per version your projects use. Versions pinned by a project are flagged.',
      'Re-downloaded automatically by ./gradlew on next build.',
      { kind: 'children' }),
    T('android', 'Gradle JDKs', h('.gradle/jdks'), 'caution',
      'JDK toolchains auto-downloaded by Gradle.', 'Re-downloaded when a build needs them.'),
    T('android', 'Android build cache', h('.android/build-cache'), 'safe',
      'Legacy Android build cache.', 'Rebuilt on next build.'),
    T('android', 'Android cache', h('.android/cache'), 'safe',
      'SDK/emulator misc cache.', 'Rebuilt automatically.'),
    T('android', 'Android metrics', h('.android/metrics'), 'safe',
      'Emulator/SDK usage metrics spool.', 'Recreated automatically.'),
    T('android', 'Emulators (AVDs)', h('.android/avd'), 'risky',
      'Full emulator devices including installed apps and user data.',
      'AVD must be recreated in Device Manager; its data is gone.',
      { kind: 'children', crossRef: 'avd', childFilter: (name) => name.endsWith('.avd') }),
    T('android', 'Emulator system images', h('Library/Android/sdk/system-images'), 'caution',
      'OS images used to create emulators.',
      'Re-download in SDK Manager. AVDs using a deleted image will not boot until then.',
      { kind: 'children' }),
    T('android', 'NDK versions', h('Library/Android/sdk/ndk'), 'caution',
      'Installed NDK versions. Versions pinned by a project (ndkVersion) are flagged.',
      'Re-download in SDK Manager.',
      { kind: 'children', crossRef: 'ndk-pin' }),
    T('android', 'Maven repository', h('.m2/repository'), 'caution',
      'Maven local dependency repository.', 'Re-downloaded on next Maven/Gradle build.'),
    T('android', 'Maven wrapper dists', h('.m2/wrapper'), 'safe',
      'Downloaded Maven distributions.', 'Re-downloaded by ./mvnw on next build.'),
    T('android', 'Kotlin/Native', h('.konan'), 'caution',
      'Kotlin/Native toolchains and dependencies.', 'Re-downloaded on next Kotlin/Native build.'),
    T('android', 'Kotlin daemon', h('.kotlin'), 'safe',
      'Kotlin daemon caches/sessions.', 'Recreated on next build.'),

    // ---- Flutter & Dart ----
    T('flutter', 'Pub cache', h('.pub-cache'), 'caution',
      'All downloaded Dart/Flutter packages for every project.',
      'flutter pub get / dart pub get re-downloads per project.'),
    T('flutter', 'Dart analysis cache', h('.dartServer'), 'safe',
      'Dart analysis server index — grows to many GB.',
      'Rebuilt automatically while editing (first analysis slower).'),
    T('flutter', 'fvm Flutter versions', h('fvm/versions'), 'caution',
      'Flutter SDK versions installed via fvm.',
      'fvm install <version> restores.',
      { kind: 'children' }),
    // Flutter SDK bin/cache is resolved dynamically by the scanner (see resolveFlutterCache).

    // ---- JavaScript & Node ----
    T('node', 'npm cache', h('.npm'), 'safe',
      'npm content-addressable download cache (_cacache) and npx cache.',
      'npm re-downloads as needed.'),
    T('node', 'Yarn cache', h('Library/Caches/Yarn'), 'safe',
      'Yarn v1 global cache.', 'Yarn re-downloads on next install.'),
    T('node', 'Yarn berry cache', h('.yarn/berry/cache'), 'safe',
      'Yarn 2+ global cache.', 'Re-downloaded on next install.'),
    T('node', 'pnpm store', h('Library/pnpm/store'), 'caution',
      'pnpm content store shared by all projects (node_modules hardlink into it).',
      'pnpm install re-downloads; existing node_modules keep working until reinstalled.'),
    T('node', 'pnpm store (legacy)', h('.pnpm-store'), 'caution',
      'pnpm content store.', 'Re-downloaded on next pnpm install.'),
    T('node', 'Bun install cache', h('.bun/install/cache'), 'safe',
      'Bun package cache.', 'Re-downloaded on next bun install.'),
    T('node', 'Bun cache', h('Library/Caches/bun'), 'safe',
      'bunx / temp cache.', 'Recreated automatically.'),
    T('node', 'Deno cache', h('Library/Caches/deno'), 'safe',
      'Deno module cache.', 'Re-downloaded on next run.'),
    T('node', 'node-gyp headers', h('Library/Caches/node-gyp'), 'safe',
      'Node headers for building native addons.', 'Re-downloaded when a native module builds.'),
    T('node', 'node-gyp headers (legacy)', h('.node-gyp'), 'safe',
      'Old node-gyp header cache location.', 'Re-downloaded if a native module builds.'),
    T('node', 'nvm cache', h('.nvm/.cache'), 'safe',
      'Downloaded Node archives.', 'Re-downloaded if a version is reinstalled.'),
    T('node', 'Node versions (nvm)', h('.nvm/versions/node'), 'caution',
      'Installed Node versions — deleting the active one breaks node until reinstalled.',
      'nvm install <version> restores.',
      { kind: 'children' }),
    T('node', 'Electron cache', h('Library/Caches/electron'), 'safe',
      'Downloaded Electron binaries.', 'Re-downloaded on next build.'),
    T('node', 'electron-builder cache', h('Library/Caches/electron-builder'), 'safe',
      'Packaging tool cache.', 'Re-downloaded on next package.'),
    T('node', 'TypeScript cache', h('Library/Caches/typescript'), 'safe',
      'ts-server package cache.', 'Recreated automatically.'),
    T('node', 'Corepack cache', h('.cache/node/corepack'), 'safe',
      'Package-manager versions downloaded by corepack.', 'Re-downloaded on demand.'),
    T('node', 'Playwright browsers', h('Library/Caches/ms-playwright'), 'caution',
      'Downloaded browser binaries for Playwright.', 'npx playwright install restores.'),
    T('node', 'Cypress binaries', h('Library/Caches/Cypress'), 'caution',
      'Cypress app binaries.', 'Re-downloaded on next cypress install/run.'),
    T('node', 'Puppeteer browsers', h('.cache/puppeteer'), 'caution',
      'Chromium builds for Puppeteer.', 'Re-downloaded on next install.'),

    // ---- Python ----
    T('python', 'pip cache', h('Library/Caches/pip'), 'safe',
      'pip wheel/download cache.', 'pip re-downloads as needed.'),
    T('python', 'Poetry cache', h('Library/Caches/pypoetry'), 'safe',
      'Poetry package cache.', 'Re-downloaded on next install.'),
    T('python', 'uv cache', h('Library/Caches/uv'), 'safe',
      'uv package cache.', 'uv re-downloads as needed.'),
    T('python', 'pipenv cache', h('Library/Caches/pipenv'), 'safe',
      'pipenv cache.', 'Recreated on next install.'),
    T('python', 'pyenv cache', h('.pyenv/cache'), 'safe',
      'Downloaded Python source archives.', 'Re-downloaded if a version is rebuilt.'),
    T('python', 'Python versions (pyenv)', h('.pyenv/versions'), 'caution',
      'Installed Python versions — virtualenvs may point into them.',
      'pyenv install <version> restores; dependent venvs must be recreated.',
      { kind: 'children' }),
    T('python', 'pre-commit cache', h('.cache/pre-commit'), 'safe',
      'Hook environments.', 'Recreated on next pre-commit run.'),
    T('python', 'Conda packages (miniconda3)', h('miniconda3/pkgs'), 'safe',
      'Conda package cache.', 'conda re-downloads; also: conda clean --all.'),
    T('python', 'Conda packages (anaconda3)', h('anaconda3/pkgs'), 'safe',
      'Conda package cache.', 'conda re-downloads; also: conda clean --all.'),
    T('python', 'Conda packages (miniforge3)', h('miniforge3/pkgs'), 'safe',
      'Conda package cache.', 'conda re-downloads.'),
    T('python', 'Conda packages (mambaforge)', h('mambaforge/pkgs'), 'safe',
      'Conda package cache.', 'conda re-downloads.'),

    // ---- Go / Rust / other languages ----
    T('langs', 'Go build cache', h('Library/Caches/go-build'), 'safe',
      'Compiled package cache.', 'Rebuilt on next build (or: go clean -cache).'),
    T('langs', 'Go module cache', h('go/pkg/mod'), 'caution',
      'Downloaded Go modules (dirs are read-only by design).',
      'go re-downloads on next build; cleanest via: go clean -modcache.'),
    T('langs', 'Cargo registry', h('.cargo/registry'), 'caution',
      'Downloaded crates.', 'cargo re-downloads on next build.'),
    T('langs', 'Cargo git checkouts', h('.cargo/git'), 'caution',
      'Git dependencies.', 'Re-cloned on next build.'),
    T('langs', 'Rustup downloads', h('.rustup/downloads'), 'safe',
      'Toolchain download cache.', 'Re-downloaded if needed.'),
    T('langs', 'Rust toolchains', h('.rustup/toolchains'), 'caution',
      'Installed Rust toolchains.', 'rustup toolchain install restores.',
      { kind: 'children' }),
    T('langs', 'Terraform plugin cache', h('.terraform.d/plugin-cache'), 'safe',
      'Shared provider download cache.', 'Re-downloaded by terraform init.'),
    T('langs', 'Rustup tmp', h('.rustup/tmp'), 'safe',
      'Temporary files.', 'Not needed.'),
    T('langs', 'SwiftPM cache', h('Library/Caches/org.swift.swiftpm'), 'safe',
      'Swift package cache.', 'Re-fetched on next resolve.'),
    T('langs', 'CocoaPods cache', h('Library/Caches/CocoaPods'), 'safe',
      'Pod download cache.', 'Re-downloaded on next pod install (or: pod cache clean --all).'),
    T('langs', 'CocoaPods specs', h('.cocoapods'), 'caution',
      'Podspec repositories.', 'Re-cloned on next pod install (slow first time).'),
    T('langs', 'Carthage cache', h('Library/Caches/org.carthage.CarthageKit'), 'safe',
      'Carthage build cache.', 'Rebuilt on next carthage run.'),
    T('langs', 'Ruby gems', h('.gem'), 'caution',
      'Installed user gems — gem-installed CLIs stop working until reinstalled.',
      'gem install restores each gem.'),
    T('langs', 'Ruby bundle cache', h('.bundle/cache'), 'safe',
      'Bundler download cache.', 'Re-downloaded on next bundle install.'),
    T('langs', 'Composer cache', h('.composer/cache'), 'safe',
      'PHP package cache.', 'Re-downloaded on next composer install.'),
    T('langs', 'NuGet packages', h('.nuget/packages'), 'caution',
      '.NET package cache.', 'Re-downloaded on next restore.'),
    T('langs', 'Haskell Stack', h('.stack'), 'caution',
      'GHC toolchains and package DBs.', 'Re-downloaded/rebuilt by stack (slow).'),
    T('langs', 'Hex packages', h('.hex'), 'caution',
      'Elixir package cache.', 'Re-downloaded by mix deps.get.'),
    T('langs', 'Mix archives', h('.mix'), 'caution',
      'Elixir build tools/archives.', 'Reinstalled with mix local.hex / local.rebar.'),
    T('langs', 'Zig cache', h('.cache/zig'), 'safe',
      'Zig global cache.', 'Rebuilt on next build.'),
    T('langs', 'Firebase emulators', h('.cache/firebase'), 'safe',
      'Firebase emulator suite JARs.', 'Re-downloaded on next emulator start.'),
    T('langs', 'SDKMAN archives', h('.sdkman/archives'), 'safe',
      'Downloaded SDK archives.', 'Re-downloaded if a version is reinstalled.'),
    T('langs', 'SDKMAN tmp', h('.sdkman/tmp'), 'safe', 'Temp files.', 'Not needed.'),
    T('langs', 'Ivy cache', h('.ivy2/cache'), 'caution',
      'Scala/sbt dependency cache.', 'Re-downloaded on next build.'),
    T('langs', 'sbt boot', h('.sbt/boot'), 'safe',
      'Scala compiler/launcher jars.', 'Re-downloaded on next sbt start.'),
    T('langs', 'ccache (legacy)', h('.ccache'), 'safe',
      'C/C++ compiler cache.', 'Rebuilt on next compile.'),
    T('langs', 'Conan packages', h('.conan2/p'), 'caution',
      'C/C++ package cache.', 'Re-downloaded/rebuilt by conan install.'),
    T('langs', 'Coursier cache', h('Library/Caches/Coursier'), 'caution',
      'Scala dependency cache.', 'Re-downloaded on next build.'),

    // ---- Game engines ----
    T('games', 'Unity global cache', h('Library/Unity/cache'), 'safe',
      'Unity package manager / GI cache shared by all projects.',
      'Re-downloaded / rebuilt when a project opens.'),
    T('games', 'Unity Asset Store downloads', h('Library/Unity/Asset Store-5.x'), 'caution',
      'Downloaded Asset Store packages.', 'Re-downloadable from the Asset Store (needs login).'),
    T('games', 'Unreal DerivedDataCache', h('Library/Application Support/Epic/UnrealEngine/Common/DerivedDataCache'), 'safe',
      'Shared shader/asset derived-data cache.', 'Rebuilt on next editor run (first open much slower).'),
    T('games', 'Epic Launcher web cache', h('Library/Application Support/Epic/EpicGamesLauncher/webcache'), 'safe',
      'Launcher Chromium cache.', 'Rebuilt automatically.'),
    T('games', 'Steam games', path.join(AS, 'Steam/steamapps/common'), 'caution',
      'Installed Steam games, one folder per game.',
      'Reinstall any game from your Steam library (large downloads).',
      { kind: 'children', normalGroup: 'n-apps' }),
    T('games', 'Steam shader cache', path.join(AS, 'Steam/steamapps/shadercache'), 'safe',
      'Pre-compiled GPU shaders per game.', 'Rebuilt automatically while playing (brief stutter at first).',
      { normalGroup: 'n-junk' }),
    T('games', 'Steam download cache', path.join(AS, 'Steam/steamapps/downloading'), 'safe',
      'Partial game downloads.', 'Only needed during an active download.',
      { normalGroup: 'n-junk' }),

    // ---- Video & audio production ----
    T('creative', 'Adobe media cache', path.join(AS, 'Adobe/Common/Media Cache Files'), 'safe',
      'Rendered preview/conform files from Premiere Pro, After Effects and Audition. A top space hog for video editors.',
      'Regenerated when a project re-opens (first playback slower).'),
    T('creative', 'Adobe media cache database', path.join(AS, 'Adobe/Common/Media Cache'), 'safe',
      'Index database for the Adobe media cache.', 'Rebuilt together with the cache.'),
    T('creative', 'Adobe audio waveform cache', path.join(AS, 'Adobe/Common/Peak Files'), 'safe',
      'Pre-computed audio waveforms used to draw audio tracks in Premiere and Audition.',
      'Recomputed when a project re-opens.'),
    T('creative', 'After Effects disk cache', h('Library/Caches/Adobe/After Effects'), 'safe',
      'After Effects render cache, one folder per version. Often the biggest single Adobe folder.',
      'Re-rendered while you work (previews rebuild as you scrub).',
      { kind: 'children' }),
    T('creative', 'Adobe installer payloads', '/Library/Application Support/Adobe/Installers', 'caution',
      'Installer payloads left by Creative Cloud after installing or updating apps (root-owned — cannot delete from here).',
      'Creative Cloud re-downloads what it needs.',
      { displayOnly: true, needs: 'root' }),
    T('creative', 'DaVinci Resolve render cache', path.join(AS, 'Blackmagic Design/DaVinci Resolve/CacheClip'), 'safe',
      'Optimized-media and render cache clips.', 'Re-rendered when the timeline plays again.'),
    T('creative', 'DaVinci Resolve proxies', path.join(AS, 'Blackmagic Design/DaVinci Resolve/ProxyMedia'), 'caution',
      'Generated proxy media files.', 'Re-generate proxies from the original clips inside Resolve.'),
    T('creative', 'Final Cut Pro backups', h('Movies/Final Cut Backups.localized'), 'caution',
      'Automatic library backups made by Final Cut Pro.', 'New backups are created as you keep editing; old restore points are lost.'),
    T('creative', 'GarageBand sound library', '/Library/Application Support/GarageBand', 'caution',
      'Instruments and loops downloaded by GarageBand (root-owned — cannot delete from here).',
      'Re-download inside GarageBand: Sound Library menu.',
      { displayOnly: true, normalGroup: 'n-media' }),
    T('creative', 'Logic Pro sound library', '/Library/Application Support/Logic', 'caution',
      'Logic Pro sample/instrument content (root-owned — cannot delete from here).',
      'Re-download inside Logic: Sound Library menu.',
      { displayOnly: true, normalGroup: 'n-media' }),
    // photography
    T('creative', 'Camera Raw cache', h('Library/Caches/Adobe Camera Raw'), 'safe',
      'Decoded RAW previews used by Lightroom, Camera Raw and Bridge.',
      'Rebuilt as you browse photos again (first pass slower).'),
    // ONLY the generated previews. Without a childFilter this registered every
    // child of the Lightroom folder — Catalog.lrcat-data (masking, healing and
    // AI-denoise data), Backups (catalog restore points) and Mobile
    // Downloads.lrdata (cloud-synced originals) — each carrying the "generated
    // JPEG previews" copy below, which is what told the user they were safe.
    T('creative', 'Lightroom previews', h('Pictures/Lightroom'), 'caution',
      'Generated JPEG previews for the Lightroom catalog, often tens of GB.',
      'Lightroom regenerates them from the originals; the catalog itself is untouched.',
      { kind: 'children',
        childFilter: (n) => /previews\.lrdata$/i.test(n) && !/smart previews\.lrdata$/i.test(n) }),
    // Smart previews are not previews in the same sense: they are lossy DNG
    // proxies that let you keep editing when the originals are offline.
    T('creative', 'Lightroom smart previews', h('Pictures/Lightroom'), 'caution',
      'Lossy DNG proxies Lightroom uses to keep editing while the original files are offline or on a disconnected drive.',
      'Rebuilt only while the originals are reachable — until then those photos cannot be edited.',
      { kind: 'children', childFilter: (n) => /smart previews\.lrdata$/i.test(n) }),
    T('creative', 'Lightroom catalog backups', h('Pictures/Lightroom/Backups'), 'caution',
      'Dated copies of the Lightroom catalog, written each time Lightroom backs it up on exit. They accumulate forever.',
      'Gone once deleted — these are the restore points for a corrupted catalog, so keep at least the most recent.',
      { kind: 'children' }),
    T('creative', 'Capture One cache', h('Library/Caches/com.captureone.captureone16'), 'safe',
      'Preview and thumbnail cache for Capture One.', 'Rebuilt while browsing sessions again.'),
    T('creative', 'Photoshop scratch & autorecover', h('Library/Application Support/Adobe/Adobe Photoshop 2026/AutoRecover'), 'caution',
      'Auto-recovery copies of documents Photoshop had open during a crash.',
      'Only useful right after a crash — saved .psd files are unaffected.'),
    T('creative', 'Sketch cache', h('Library/Caches/com.bohemiancoding.sketch3'), 'safe',
      'Sketch document/thumbnail cache.', 'Rebuilt when documents re-open.'),
    T('creative', 'Figma desktop cache', h('Library/Application Support/Figma/Desktop'), 'safe',
      'Offline copies of Figma files and the desktop app cache.',
      'Re-downloaded from figma.com when a file opens.'),
    T('creative', 'Blender cache', h('Library/Caches/Blender'), 'safe',
      'Physics/render cache written by Blender.', 'Re-simulated or re-rendered on demand.'),

    // ---- Docker & VMs ----
    T('docker', 'Docker Desktop data', h('Library/Containers/com.docker.docker'), 'risky',
      'ALL Docker images, containers and volumes live in here (Docker.raw).',
      'Everything must be re-pulled/rebuilt. Prefer: docker system prune -a (with Docker running).'),
    T('docker', 'OrbStack data', h('.orbstack'), 'risky',
      'OrbStack VMs and container data.', 'Machines/containers must be recreated.'),
    T('docker', 'Colima VM', h('.colima'), 'risky',
      'Colima VM disk (all containers inside).', 'colima start recreates an empty VM.'),
    T('docker', 'Lima VMs', h('.lima'), 'risky',
      'Lima VM disks.', 'limactl start recreates empty VMs.'),
    T('docker', 'Vagrant boxes', h('.vagrant.d/boxes'), 'caution',
      'Downloaded base boxes.', 'vagrant up re-downloads.'),
    T('docker', 'kubectl cache', h('.kube/cache'), 'safe',
      'API discovery cache.', 'Rebuilt on next kubectl call.'),
    T('docker', 'kubectl http cache', h('.kube/http-cache'), 'safe',
      'HTTP response cache.', 'Rebuilt on next kubectl call.'),
    T('docker', 'Pulumi plugins', h('.pulumi/plugins'), 'caution',
      'Downloaded provider plugins.', 'Re-downloaded on next pulumi up.'),
    T('docker', 'minikube', h('.minikube'), 'caution',
      'minikube VM/images.', 'minikube start recreates.'),
    T('docker', 'UTM VMs', h('Library/Containers/com.utmapp.UTM'), 'risky',
      'Full virtual machines with their disks.', 'Cannot be regenerated.'),
    T('docker', 'Parallels VMs', h('Parallels'), 'risky',
      'Full virtual machines.', 'Cannot be regenerated.'),
    T('docker', 'VirtualBox VMs', h('VirtualBox VMs'), 'risky',
      'Full virtual machines.', 'Cannot be regenerated.'),

    // ---- IDEs & Editors ----
    // macOS quirk: Caches/JetBrains|Google is the IDE *system* dir — it holds
    // LocalHistory (unsaved-change/deleted-file recovery), so that subdir is
    // preserved via contentsExclude while everything else is swept.
    T('ide', 'JetBrains caches', h('Library/Caches/JetBrains'), 'safe',
      'IDE caches and indexes, one per product/version. Local History is kept.',
      'Rebuilt on next IDE start (first open slower).',
      { kind: 'children', childDeleteMode: 'contents', contentsExclude: ['LocalHistory'] }),
    T('ide', 'Android Studio caches', h('Library/Caches/Google'), 'safe',
      'Android Studio / Google IDE caches and Chrome cache (split per product). Local History is kept.',
      'Rebuilt automatically.',
      { kind: 'children', crossRef: 'as-version', childDeleteMode: 'contents', contentsExclude: ['LocalHistory'] }),
    T('ide', 'Android Studio profiles (old)', h('Library/Application Support/Google'), 'caution',
      'IDE settings/plugins per version — old versions are leftovers after upgrades.',
      'Current version keeps working; old versions only matter if you roll back.',
      { kind: 'children', crossRef: 'as-version', childFilter: (n) => n.startsWith('AndroidStudio') }),
    T('ide', 'VS Code cache', path.join(AS, 'Code/Cache'), 'safe',
      'HTTP cache.', 'Rebuilt automatically.'),
    T('ide', 'VS Code CachedData', path.join(AS, 'Code/CachedData'), 'safe',
      'V8 code cache.', 'Rebuilt automatically.'),
    T('ide', 'VS Code Code Cache', path.join(AS, 'Code/Code Cache'), 'safe',
      'Compiled JS cache.', 'Rebuilt automatically.'),
    T('ide', 'VS Code GPUCache', path.join(AS, 'Code/GPUCache'), 'safe',
      'GPU shader cache.', 'Rebuilt automatically.'),
    T('ide', 'VS Code extension VSIXs', path.join(AS, 'Code/CachedExtensionVSIXs'), 'safe',
      'Downloaded extension packages.', 'Re-downloaded if needed.'),
    T('ide', 'VS Code logs', path.join(AS, 'Code/logs'), 'safe', 'Session logs.', 'New logs written.'),
    T('ide', 'VS Code workspaceStorage', path.join(AS, 'Code/User/workspaceStorage'), 'caution',
      'Per-workspace state incl. extension data (e.g. local-history extensions).',
      'Workspaces reset to defaults on next open.'),
    T('ide', 'Cursor cache', path.join(AS, 'Cursor/Cache'), 'safe', 'HTTP cache.', 'Rebuilt automatically.'),
    T('ide', 'Cursor CachedData', path.join(AS, 'Cursor/CachedData'), 'safe', 'V8 code cache.', 'Rebuilt automatically.'),
    T('ide', 'Cursor Code Cache', path.join(AS, 'Cursor/Code Cache'), 'safe', 'Compiled JS cache.', 'Rebuilt automatically.'),
    T('ide', 'Cursor GPUCache', path.join(AS, 'Cursor/GPUCache'), 'safe', 'GPU cache.', 'Rebuilt automatically.'),
    T('ide', 'Cursor logs', path.join(AS, 'Cursor/logs'), 'safe', 'Session logs.', 'New logs written.'),
    T('ide', 'Cursor workspaceStorage', path.join(AS, 'Cursor/User/workspaceStorage'), 'caution',
      'Per-workspace state.', 'Workspaces reset on next open.'),
    T('ide', 'VS Code extensions', h('.vscode/extensions'), 'caution',
      'Installed extensions.', 'Reinstall from marketplace.'),
    T('ide', 'Cursor extensions', h('.cursor/extensions'), 'caution',
      'Installed extensions.', 'Reinstall from marketplace.'),
    T('ide', 'Claude Code transcripts', h('.claude/projects'), 'risky',
      'Session history/transcripts for Claude Code — likely in use right now.',
      'Past session history is gone permanently.'),
    T('ide', 'Claude Code shell snapshots', h('.claude/shell-snapshots'), 'safe',
      'Shell environment snapshots.', 'Recreated on next session.'),
    T('ide', 'Gemini CLI / Antigravity data (~/.gemini)', h('.gemini'), 'risky',
      'Home of the Gemini CLI: Google OAuth login, GEMINI.md memory, session history — plus Antigravity browser-profile data if installed.',
      'Login, memory and history cannot be regenerated — you would re-login and lose GEMINI.md/history.'),
    T('ide', 'Antigravity data', h('.antigravity'), 'caution',
      'Antigravity IDE state.', 'Only matters if you still use Antigravity.'),
    T('ide', 'Antigravity app profile', path.join(AS, 'Antigravity'), 'caution',
      'Antigravity IDE application profile — leftover if the app was removed.',
      'Only matters if you still use Antigravity.'),
    // Naming these editors is what keeps their caches out of the consumer
    // "App Caches" card: the Electron sweep inherits the category of the app
    // folder it finds registered here.
    T('ide', 'Antigravity IDE profile', path.join(AS, 'Antigravity IDE'), 'caution',
      'Antigravity IDE workspace state, settings and extensions.',
      'Settings and workspace state reset to defaults on next launch.'),
    T('ide', 'Windsurf profile', path.join(AS, 'Windsurf'), 'caution',
      'Windsurf editor settings, extensions and workspace state.',
      'Reinstall extensions / re-open workspaces after deleting.'),
    T('ide', 'Codex profile', path.join(AS, 'Codex'), 'caution',
      'Codex app data.', 'Recreated on next launch; sign-in may be required.'),
    T('ide', 'Codex data (com.openai.codex)', path.join(AS, 'com.openai.codex'), 'caution',
      'Codex application support data.', 'Recreated on next launch.'),
    T('docker', 'Docker Desktop app data', path.join(AS, 'Docker Desktop'), 'caution',
      'Docker Desktop settings and update downloads (images and containers live elsewhere).',
      'Recreated on next launch; your images are untouched.'),

    // ---- Browsers (cache only, never profiles) ----
    T('browsers', 'Firefox cache', h('Library/Caches/Firefox'), 'safe',
      'Web cache.', 'Rebuilt while browsing.'),
    T('browsers', 'Safari cache', h('Library/Caches/com.apple.Safari'), 'safe',
      'Web cache (may need Full Disk Access to read).', 'Rebuilt while browsing.'),
    T('browsers', 'Arc cache', h('Library/Caches/Arc'), 'safe', 'Web cache.', 'Rebuilt while browsing.'),
    T('browsers', 'Brave cache', h('Library/Caches/BraveSoftware'), 'safe', 'Web cache.', 'Rebuilt while browsing.'),
    T('browsers', 'Edge cache', h('Library/Caches/com.microsoft.edgemac'), 'safe', 'Web cache.', 'Rebuilt while browsing.'),

    // ---- Apps ----
    T('apps', 'Claude desktop VM bundles', path.join(AS, 'Claude/vm_bundles'), 'caution',
      'Downloaded VM images for Claude desktop sandboxing.', 'Re-downloaded when needed.',
      { normalGroup: 'n-dev' }),
    T('apps', 'Spotify cache', path.join(AS, 'Spotify/PersistentCache'), 'caution',
      'Streaming cache — downloaded offline tracks live here too.',
      'Re-cached while listening; offline downloads must be re-downloaded in the app.'),
    T('apps', 'Zoom downloaded updates', path.join(AS, 'zoom.us/AutoUpdater'), 'safe',
      'Installer packages Zoom downloaded to update itself. Zoom is already updated by the time these sit here.',
      'Re-downloaded when the next Zoom update arrives.',
      { normalGroup: 'n-junk' }),
    T('apps', 'Google updater downloads', h('Library/Caches/com.google.SoftwareUpdate/Downloads'), 'safe',
      'Installers downloaded by Google’s updater for Chrome, Drive and Earth.',
      'Re-downloaded when the next update arrives.',
      { normalGroup: 'n-junk' }),
    T('apps', 'Microsoft AutoUpdate downloads', '/Library/Application Support/Microsoft/MAU2.0/Microsoft AutoUpdate.app/Contents/Resources', 'caution',
      'Update payloads kept by Microsoft AutoUpdate for Office (root-owned — cannot delete from here). Do not remove the whole MAU2.0 folder: that breaks Office security updates.',
      'Re-downloaded by Microsoft AutoUpdate when the next Office update arrives.',
      { displayOnly: true, needs: 'root', normalGroup: 'n-junk' }),
    T('apps', 'Zoom app data', path.join(AS, 'zoom.us'), 'caution',
      'Zoom app data and update downloads.', 'Zoom recreates; you stay logged in via keychain.'),
    T('apps', 'Zoom recordings', h('Documents/Zoom'), 'risky',
      'Local meeting recordings — user-created content.', 'Cannot be regenerated.',
      { normalGroup: 'n-large' }),
    T('apps', 'Telegram data', h('Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram'), 'risky',
      'Telegram media cache including downloads.', 'Media re-downloads from chats; local-only files are lost.'),
    T('apps', 'WhatsApp data', h('Library/Group Containers/group.net.whatsapp.WhatsApp.shared'), 'risky',
      'WhatsApp messages/media data.', 'May require re-sync; local media can be lost.'),
    T('apps', 'Dropbox cache', h('Dropbox/.dropbox.cache'), 'safe',
      'Sync cache.', 'Rebuilt while syncing.', { normalGroup: 'n-cloud' }),
    T('apps', 'Microsoft Teams cache', h('Library/Containers/com.microsoft.teams2/Data/Library/Caches'), 'safe',
      'Teams message, image and avatar cache.', 'Rebuilt after the next sign-in; chats live on the server.'),
    T('apps', 'Microsoft Office document cache', h('Library/Containers/com.microsoft.Word/Data/Library/Caches'), 'safe',
      'Word render/font cache.', 'Rebuilt automatically; documents are untouched.'),
    T('apps', 'Outlook cache', h('Library/Containers/com.microsoft.Outlook/Data/Library/Caches'), 'safe',
      'Outlook attachment and image cache.', 'Re-downloaded from the mail server.'),
    T('apps', 'Slack cache', h('Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Caches'), 'safe',
      'Slack files, images and app cache.', 'Re-downloaded from the workspace.'),
    T('apps', 'OneDrive cache', h('Library/Caches/com.microsoft.OneDrive'), 'safe',
      'OneDrive sync cache.', 'Rebuilt while syncing.', { normalGroup: 'n-cloud' }),
    // This folder is the sync *database*, not the documents — the files
    // themselves are in ~/Library/Mobile Documents, listed below. Calling it
    // "your iCloud Drive" told the user their space was accounted for when it
    // was not.
    T('apps', 'iCloud sync database', h('Library/Application Support/CloudDocs'), 'caution',
      'Bookkeeping macOS keeps for iCloud Drive syncing — not your documents.',
      'Rebuilt by macOS; deleting it forces a full re-sync.',
      { displayOnly: true, needs: 'fda', normalGroup: 'n-cloud' }),
    // NEVER enumerate these from the main thread. They are served by the File
    // Provider daemon: one readdir/realpath inside them can block forever when
    // it stalls, and the server's event loop blocks with it — the whole app
    // freezes, window and all. noStat skips every synchronous probe and the
    // size comes from a killable `du` instead.
    T('apps', 'iCloud Drive files kept on this Mac', h('Library/Mobile Documents'), 'caution',
      'Your iCloud Drive documents, as stored on this Mac (including Desktop and Documents if you sync them).',
      'Free space the safe way: in Finder, right-click a file or folder and choose “Remove Download” — the file stays in iCloud. Deleting here would delete it from iCloud on every device.',
      { displayOnly: true, needs: 'fda', normalGroup: 'n-cloud', sizeVia: 'du', noStat: true }),
    T('apps', 'Dropbox / OneDrive / Drive files kept on this Mac', h('Library/CloudStorage'), 'caution',
      'Where macOS keeps the files your cloud apps mirror onto this disk. Often the largest folder a normal Mac has.',
      'Use the provider’s own “Free up space” / “Online-only” option in Finder — deleting here can remove the file from the cloud too.',
      { displayOnly: true, needs: 'fda', normalGroup: 'n-cloud', sizeVia: 'du', noStat: true }),
    T('apps', 'Google Drive cache', path.join(AS, 'Google/DriveFS'), 'caution',
      'Local cache of Google Drive cloud files. Quit Google Drive before deleting — you may need to sign in again.',
      'Drive re-syncs everything from the cloud.',
      { normalGroup: 'n-cloud' }),

    // ---- AI & ML ----
    T('ai', 'Ollama models', h('.ollama/models'), 'caution',
      'Downloaded LLM models.', 'ollama pull re-downloads (large).'),
    T('ai', 'HuggingFace cache', h('.cache/huggingface'), 'caution',
      'Models and datasets.', 'Re-downloaded on next use (large).'),
    T('ai', 'LM Studio models', h('.lmstudio/models'), 'caution',
      'Downloaded models (chat history in ~/.lmstudio is NOT touched).', 'Re-downloaded in app.'),
    T('ai', 'Torch cache', h('.cache/torch'), 'caution',
      'Model weights cache.', 'Re-downloaded on next use.'),
    T('ai', 'Whisper models', h('.cache/whisper'), 'caution',
      'Speech models.', 'Re-downloaded on next run.'),

    // ---- Device backups ----
    T('backups', 'iPhone/iPad backups', path.join(AS, 'MobileSync/Backup'), 'risky',
      'Full device backups. Deleting loses those restore points permanently.',
      'Only a new backup of the device recreates one. iCloud backups are separate and unaffected.',
      { kind: 'children', crossRef: 'ios-backup', needs: 'fda' }),

    // ---- Generic user caches (claims-deduped against everything above) ----
    T('caches-user', 'App caches', h('Library/Caches'), 'safe',
      'Per-app cache folders. Apps rebuild them automatically.',
      'Rebuilt automatically by each app.',
      { kind: 'children', childExclude: ['com.apple.bird', 'CloudKit'], generic: true }),
    T('caches-user', 'XDG cache (~/.cache)', h('.cache'), 'safe',
      'Command-line tool caches.', 'Rebuilt automatically by each tool.',
      { kind: 'children', generic: true }),
    T('caches-user', 'Saved application state', h('Library/Saved Application State'), 'safe',
      'Window-restore state per app.', 'Recreated when apps quit.'),

    // ---- System (mostly root-owned → display-only) ----
    T('caches-system', 'System-wide caches', '/Library/Caches', 'caution',
      'Shared app caches (often root-owned).', 'Rebuilt automatically.',
      { kind: 'children' }),
    T('caches-system', 'App logs', h('Library/Logs'), 'safe',
      'Application log files.', 'New logs written as apps run.',
      { kind: 'children', generic: true }),
    T('caches-system', 'System logs', '/private/var/log', 'caution',
      'System log files (root-owned — cannot delete from here).', 'Managed by macOS.',
      { displayOnly: true }),
  ];
}

// Electron-style cache dirs swept from ~/Library/Application Support/<App>/.
// Covers Slack, Discord, Notion, Postman, etc. automatically. Claims-deduped.
export const ELECTRON_SWEEP = {
  base: AS,
  subdirs: ['Cache', 'Code Cache', 'GPUCache', 'Service Worker/CacheStorage', 'CachedData'],
  safety: 'safe',
  why: 'Electron/Chromium cache inside the app’s data folder.',
  regen: 'Rebuilt automatically by the app.',
  // Never sweep inside these (real user data lives next to the caches):
  skipApps: ['MobileSync', 'Google'],
};

// Chromium-family per-profile caches. Profiles hold history/cookies/logins so
// they are never swept whole — only these pure-cache subdirs are targeted.
export const CHROMIUM_PROFILE_SWEEP = {
  browsers: [
    { name: 'Chrome', dir: path.join(AS, 'Google/Chrome') },
    { name: 'Edge', dir: path.join(AS, 'Microsoft Edge') },
    { name: 'Brave', dir: path.join(AS, 'BraveSoftware/Brave-Browser') },
    { name: 'Chromium', dir: path.join(AS, 'Chromium') },
    { name: 'Arc', dir: path.join(AS, 'Arc/User Data') },
  ],
  rootSubdirs: ['GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'component_crx_cache', 'Crashpad'],
  // Service Worker/CacheStorage is what offline-capable sites (Gmail, Figma,
  // YouTube Music) fill up — Chromium never caps it, so it reaches many GB.
  profileSubdirs: ['Code Cache', 'GPUCache', 'Service Worker/CacheStorage'],
  safety: 'safe',
  why: 'Compiled JS / GPU shader / offline site cache inside the browser profile. No history, cookies or logins.',
  regen: 'Rebuilt while browsing.',
};

// Apps that update themselves through Sparkle leave the downloaded .dmg/.zip
// of every update in their own cache dir. Matched as
// ~/Library/Caches/<bundle-id>/org.sparkle-project.Sparkle.
export const UPDATER_SWEEP = {
  base: h('Library', 'Caches'),
  sub: 'org.sparkle-project.Sparkle',
  group: 'caches-user',
  normalGroup: 'n-junk',
  safety: 'safe',
  why: 'Update installers the app downloaded to update itself. The app is already updated — these are the leftovers.',
  regen: 'Re-downloaded when the app updates again.',
};

// Sandboxed app caches. macOS may purge any Caches dir under storage pressure,
// so apps must already tolerate losing these. Claims dedup keeps risky
// containers (Docker, UTM, Telegram, WhatsApp) out automatically.
export const SANDBOX_SWEEPS = [
  { base: h('Library', 'Containers'), sub: 'Data/Library/Caches', label: 'sandbox cache' },
  { base: h('Library', 'Group Containers'), sub: 'Library/Caches', label: 'group cache' },
];

// ---- Project walker rules ----
// match: exact dir name (or prefix). siblings: at least one must exist next to
// the dir for the rule to fire (kills false positives on generic names).
export const ARTIFACT_RULES = [
  { dir: 'node_modules', safety: 'caution', why: 'Installed npm dependencies for this project.', regen: 'npm/yarn/pnpm/bun install restores.' },
  { dir: 'build', siblings: ['pubspec.yaml', 'gradlew', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'CMakeLists.txt', 'setup.py', 'package.json', 'pyproject.toml', 'Podfile'], safety: 'safe', why: 'Generated build output for this project.', regen: 'Regenerated by the next build.' },
  { dir: '.dart_tool', safety: 'safe', why: 'Dart/Flutter tool cache.', regen: 'Regenerated by flutter pub get / next build.' },
  { dir: '.gradle', siblings: ['gradlew', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'], safety: 'safe', why: 'Project-local Gradle cache.', regen: 'Regenerated on next build.' },
  { dir: 'target', siblings: ['Cargo.toml', 'pom.xml', 'build.sbt'], safety: 'safe', why: 'Rust/Maven/sbt build output.', regen: 'Regenerated by next build.' },
  { dir: 'dist', siblings: ['package.json', 'pyproject.toml', 'setup.py'], safety: 'safe', why: 'Distribution build output.', regen: 'Regenerated by the build script.' },
  { dir: 'out', siblings: ['package.json'], safety: 'safe', why: 'Build output.', regen: 'Regenerated by next build.' },
  { dir: '.next', siblings: ['package.json'], safety: 'safe', why: 'Next.js build cache/output.', regen: 'next build / next dev regenerates.' },
  { dir: '.nuxt', siblings: ['package.json'], safety: 'safe', why: 'Nuxt build cache.', regen: 'Regenerated on next build.' },
  { dir: '.output', siblings: ['package.json'], safety: 'safe', why: 'Nitro/Nuxt output.', regen: 'Regenerated on next build.' },
  { dir: '.turbo', safety: 'safe', why: 'Turborepo cache.', regen: 'Regenerated on next build.' },
  { dir: '.parcel-cache', safety: 'safe', why: 'Parcel cache.', regen: 'Regenerated on next build.' },
  { dir: '.angular', safety: 'safe', why: 'Angular build cache.', regen: 'Regenerated on next build.' },
  { dir: '.expo', siblings: ['package.json'], safety: 'safe', why: 'Expo project cache.', regen: 'Regenerated by expo start.' },
  { dir: '.serverless', siblings: ['serverless.yml', 'package.json'], safety: 'safe', why: 'Serverless packaging output.', regen: 'Regenerated on next deploy.' },
  { dir: '.svelte-kit', siblings: ['package.json'], safety: 'safe', why: 'SvelteKit build cache.', regen: 'Regenerated on next dev/build.' },
  { dir: '.astro', siblings: ['package.json'], safety: 'safe', why: 'Astro build cache.', regen: 'Regenerated on next build.' },
  { dir: '.docusaurus', siblings: ['package.json'], safety: 'safe', why: 'Docusaurus build cache.', regen: 'Regenerated on next build.' },
  { dir: '.cache', siblings: ['package.json'], safety: 'safe', why: 'Bundler cache (Gatsby/webpack/etc.).', regen: 'Regenerated on next build.' },
  { dir: '.aws-sam', siblings: ['template.yaml', 'template.yml'], safety: 'safe', why: 'SAM build output.', regen: 'Regenerated by sam build.' },
  { dir: 'vendor', siblings: ['composer.json', 'go.mod'], safety: 'caution', why: 'Installed dependencies (PHP composer / Go vendor).', regen: 'composer install / go mod vendor restores.' },
  { dir: 'Pods', siblings: ['Podfile'], safety: 'caution', why: 'Installed CocoaPods for this project.', regen: 'pod install restores.' },
  { dir: 'Carthage', siblings: ['Cartfile'], safety: 'caution', why: 'Carthage builds.', regen: 'carthage update restores.' },
  { dir: 'DerivedData', safety: 'safe', why: 'Project-local Xcode build data.', regen: 'Regenerated on next build.' },
  { dir: '.venv', safety: 'caution', why: 'Python virtualenv.', regen: 'Recreate + pip install -r requirements.' },
  { dir: 'venv', siblings: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'], safety: 'caution', why: 'Python virtualenv.', regen: 'Recreate + reinstall packages.' },
  { dir: '__pycache__', safety: 'safe', why: 'Compiled Python bytecode.', regen: 'Regenerated on next run.' },
  { dir: '.pytest_cache', safety: 'safe', why: 'pytest cache.', regen: 'Regenerated on next test run.' },
  { dir: '.mypy_cache', safety: 'safe', why: 'mypy cache.', regen: 'Regenerated on next check.' },
  { dir: '.ruff_cache', safety: 'safe', why: 'ruff cache.', regen: 'Regenerated on next lint.' },
  { dir: '.tox', safety: 'safe', why: 'tox environments.', regen: 'Recreated on next tox run.' },
  { dir: '.terraform', safety: 'caution', why: 'Terraform providers/modules (state stays in .tfstate).', regen: 'terraform init restores.' },
  { dir: 'coverage', siblings: ['package.json', 'pyproject.toml'], safety: 'safe', why: 'Coverage reports.', regen: 'Regenerated by test runs.' },
  { dir: '.nyc_output', safety: 'safe', why: 'Coverage data.', regen: 'Regenerated by test runs.' },
  { dir: '.build', siblings: ['Package.swift'], safety: 'safe', why: 'SwiftPM build dir.', regen: 'Regenerated by swift build.' },
  { dir: '_build', siblings: ['mix.exs'], safety: 'safe', why: 'Elixir build output.', regen: 'Regenerated by mix compile.' },
  { dir: 'deps', siblings: ['mix.exs'], safety: 'caution', why: 'Elixir dependencies.', regen: 'mix deps.get restores.' },
  { dir: '.stack-work', safety: 'safe', why: 'Haskell Stack build dir.', regen: 'Regenerated by stack build.' },
  { dir: 'zig-cache', safety: 'safe', why: 'Zig build cache.', regen: 'Regenerated on next build.' },
  { dir: '.zig-cache', safety: 'safe', why: 'Zig build cache.', regen: 'Regenerated on next build.' },
  { dir: 'zig-out', safety: 'safe', why: 'Zig build output.', regen: 'Regenerated on next build.' },
  { prefix: 'cmake-build-', safety: 'safe', why: 'CMake build dir.', regen: 'Regenerated on next build.' },
  // Game engines. Generic dir names gated by engine-unique siblings.
  { dir: 'Library', siblings: ['ProjectSettings'], safety: 'safe', why: 'Unity imported-asset cache for this project.', regen: 'Unity reimports on next open (big projects: slow first open).' },
  { dir: 'Temp', siblings: ['ProjectSettings'], safety: 'safe', why: 'Unity temp build files.', regen: 'Regenerated on next open.' },
  { dir: 'obj', siblings: ['ProjectSettings'], safety: 'safe', why: 'Unity C# build intermediates.', regen: 'Regenerated on next build.' },
  { dir: 'Intermediate', siblings: ['Content', 'Config', 'Source'], safety: 'safe', why: 'Unreal build intermediates.', regen: 'Regenerated on next build.' },
  { dir: 'DerivedDataCache', siblings: ['Content', 'Config'], safety: 'safe', why: 'Unreal project derived-data cache.', regen: 'Rebuilt on next editor open (slower).' },
  { dir: 'Binaries', siblings: ['Content', 'Config'], safety: 'caution', why: 'Unreal compiled binaries — editor needs a recompile after deleting.', regen: 'Rebuilt by next full build (needs toolchain).' },
  { dir: '.godot', siblings: ['project.godot'], safety: 'safe', why: 'Godot imported-asset cache.', regen: 'Reimported on next open.' },
  { dir: 'elm-stuff', siblings: ['elm.json'], safety: 'safe', why: 'Elm build cache.', regen: 'Regenerated on next build.' },
];

// Home-walk config
export const WALK = {
  maxDepth: 8,
  fanoutDepth: 2, // levels fanned out as separate parallel walk tasks
  // Never descended by the MAIN walk (relative to home). Movies/Music/Pictures
  // are covered by the separate media walk below instead.
  topExcludes: ['Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public', '.Trash'],
  largeFileMin: 50 * 1024 * 1024,   // "Biggest Files" threshold
  binaryExts: ['.apk', '.aab', '.ipa'],
  binaryMin: 5 * 1024 * 1024,
  installerExts: ['.dmg', '.pkg', '.xip', '.iso', '.zip', '.tar.gz', '.tgz'],
  installerMin: 5 * 1024 * 1024,
  // duplicate detection: files >= dupMin are size-grouped, then hashed.
  // 1 MB catches the case people actually care about — photos exported twice,
  // PDFs saved in two places — while the size-collision prefilter keeps the
  // hashing workload tiny (only same-size pairs are ever read).
  dupMin: 1 * 1024 * 1024,
  // media dirs walked by the dedicated media walk (excluded from main walk)
  mediaDirs: ['Movies', 'Music', 'Pictures'],
  // library packages are opaque bundles — deleting files inside corrupts them
  packageSkips: ['.photoslibrary', '.musiclibrary', '.tvlibrary', '.aplibrary',
    '.fcpbundle', '.imovielibrary', '.theater', '.migratedphotolibrary'],
  // Everything else macOS treats as a package: a directory the Finder shows as
  // a single file. The walker must not descend into these either — a 300 MB
  // take inside a .logicx, or the executable inside a .app, is not a "big file
  // you forgot about", it is one part of something that breaks when a part is
  // removed. Kept SEPARATE from packageSkips because these get their own
  // deletable row (see onFoundBundle); packageSkips rows are displayOnly.
  //
  // Deliberately NOT here: '.pkg' — installerExts depends on flat .pkg files
  // still being reported as installers in ~/Downloads.
  opaqueBundles: [
    '.app', '.framework', '.bundle', '.plugin', '.prefpane', '.kext', '.qlgenerator',
    '.sparsebundle', '.sparseimage', '.dmgpart', '.pvm', '.vmwarevm', '.utm', '.vbox',
    '.key', '.pages', '.numbers', '.rtfd', '.scptd', '.webarchive',
    '.band', '.logicx', '.garageband', '.aupreset',
    '.xcodeproj', '.xcworkspace', '.xcarchive', '.playground', '.dsym',
    '.lrdata', '.lrcat-data', '.abbu', '.mpkg',
  ],
};

export const SUGGESTED_COMMANDS = [
  { title: 'Homebrew', cmd: 'brew cleanup --prune=all && brew autoremove', desc: 'Purge old formula versions and downloads' },
  { title: 'Docker', cmd: 'docker system prune -a --volumes', desc: 'Remove unused images/containers/volumes (Docker must be running; destructive to unused data)' },
  { title: 'Simulators', cmd: 'xcrun simctl delete unavailable', desc: 'Delete simulators whose runtime is gone' },
  { title: 'Simulator runtimes', cmd: 'xcrun simctl runtime list', desc: 'List runtime images; delete with: xcrun simctl runtime delete <id>' },
  { title: 'Time Machine snapshots', cmd: 'tmutil listlocalsnapshots /', desc: 'List local snapshots; delete: sudo tmutil deletelocalsnapshots <date>' },
  { title: 'Thin TM snapshots', cmd: 'sudo tmutil thinlocalsnapshots / 999999999999 4', desc: 'Ask macOS to purge local Time Machine snapshots aggressively (the supported way)' },
  { title: 'Stuck macOS update', cmd: 'sudo rm -rf "/macOS Install Data"', desc: 'ONLY if an interrupted macOS update left this folder behind — Software Update recreates it when needed' },
  { title: 'iCloud Drive local copies', cmd: 'brctl evict ~/Library/Mobile\\ Documents/com~apple~CloudDocs/<folder>', desc: 'Remove the local copy of an iCloud folder while keeping it in iCloud (same as Finder’s “Remove Download”)' },
  { title: 'Spotlight rebuild', cmd: 'sudo mdutil -E /', desc: 'Erase and rebuild the Spotlight index (fixes a bloated index; re-indexing takes a while)' },
  { title: 'System maintenance', cmd: 'sudo periodic daily weekly monthly', desc: 'Run macOS log/temp maintenance scripts now (clears parts of System Data)' },
  { title: 'Go modules', cmd: 'go clean -cache -modcache -testcache', desc: 'Clean Go caches the supported way' },
  { title: 'Conda', cmd: 'conda clean --all', desc: 'Clean conda package caches' },
  { title: 'CocoaPods', cmd: 'pod cache clean --all', desc: 'Clean pod cache the supported way' },
  { title: 'Ruby gems', cmd: 'gem cleanup', desc: 'Remove old versions of installed gems' },
  { title: 'Bazel', cmd: 'bazel clean --expunge', desc: 'Clean Bazel output base (run inside a Bazel workspace)' },
];

// Friendly names for reverse-DNS cache folder names
const FRIENDLY = {
  'com.apple.dt.Xcode': 'Xcode', 'com.google.Chrome': 'Chrome', 'Google': 'Google (Chrome + Android Studio)',
  'com.spotify.client': 'Spotify', 'com.tinyspeck.slackmacgap': 'Slack', 'com.hnc.Discord': 'Discord',
  'us.zoom.xos': 'Zoom', 'com.microsoft.VSCode': 'VS Code', 'com.apple.Safari': 'Safari',
  'org.mozilla.firefox': 'Firefox', 'Firefox': 'Firefox', 'Homebrew': 'Homebrew', 'pip': 'pip',
  'JetBrains': 'JetBrains', 'com.microsoft.edgemac': 'Edge', 'BraveSoftware': 'Brave',
  'company.thebrowser.Browser': 'Arc', 'com.figma.Desktop': 'Figma', 'notion.id': 'Notion',
  'com.postmanlabs.mac': 'Postman', 'ms-playwright': 'Playwright', 'com.docker.docker': 'Docker',
  'com.apple.amp.itmstransporter': 'App Store Uploads', 'org.swift.swiftpm': 'SwiftPM',
  'com.github.GitHubClient': 'GitHub Desktop', 'com.googlecode.iterm2': 'iTerm2',
};

// Platform words that carry no product identity: com.raycast.macos is
// "Raycast", not "Macos".
const PLATFORM_SEGMENTS = new Set([
  'macos', 'macosx', 'mac', 'osx', 'ios', 'desktop', 'app', 'client',
  'shared', 'group', 'groups',
]);

export function prettyName(dirname) {
  if (FRIENDLY[dirname]) return FRIENDLY[dirname];
  // iCloud containers use "~" where a bundle id uses "." and are often
  // prefixed with a team id: "F3LWYJ7GM7~com~apple~mobilegarageband".
  // Left raw, an entire category reads as gibberish to a normal user.
  if (dirname.includes('~')) {
    const bundle = dirname
      .replace(/^[0-9A-Z]{10}~/, '')   // team id prefix
      .replace(/^iCloud~/, '')         // iCloud container prefix
      .replaceAll('~', '.');
    return bundle === 'com.apple.CloudDocs' ? 'iCloud Drive' : prettyName(bundle);
  }
  if (dirname === '.Trash') return 'Deleted iCloud files';
  // reverse-DNS → last segment that actually names the product
  if (/^(com|org|net|io|dev|app|us|ru|co|ai)\./.test(dirname)) {
    const parts = dirname.split('.');
    let label = null;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (!PLATFORM_SEGMENTS.has(parts[i].toLowerCase())) { label = parts[i]; break; }
    }
    label = label || parts[parts.length - 1];
    return label.charAt(0).toUpperCase() + label.slice(1) + ` (${dirname})`;
  }
  return dirname;
}
