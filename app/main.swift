// Mac Cleaner — native wrapper.
//
// A thin WKWebView shell around the zero-dependency Node dashboard. The whole
// point of this wrapper is TCC identity: when the user grants Full Disk Access
// to "Mac Cleaner" in System Settings, the node child process spawned here
// inherits that grant (TCC attributes the responsible process), so the scanner
// can see Safari/Mail/backups without the user touching terminal permissions.
//
// Lifecycle: spawn node with PORT=0, read "LISTENING <port>" from its stdout,
// load http://127.0.0.1:<port>, SIGTERM the child on quit.

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var loaded = false

    // ---- node discovery: bundled runtime first, Homebrew/system fallbacks --

    func findNode() -> String? {
        var candidates: [String] = []
        if let res = Bundle.main.resourcePath {
            candidates.append(res + "/node")
        }
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ])
        let fm = FileManager.default
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Mac Cleaner could not start"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // ---- app lifecycle ----------------------------------------------------

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()

        guard let res = Bundle.main.resourcePath,
              FileManager.default.fileExists(atPath: res + "/server/server.js") else {
            fail("The bundled server files are missing. Re-download the app.")
            return
        }
        guard let node = findNode() else {
            fail("No Node.js runtime found. The bundled runtime is missing and no system Node was found at /opt/homebrew/bin/node or /usr/local/bin/node.")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [res + "/server/server.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: res + "/server")
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = "0"          // ephemeral: never collide with a manual ./run.sh
        env["APP_MODE"] = "1"      // switches FDA onboarding wording in the UI
        proc.environment = env

        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.standardError

        var buffer = ""
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self, !self.loaded else { return }
            guard let chunk = String(data: handle.availableData, encoding: .utf8), !chunk.isEmpty else { return }
            buffer += chunk
            for line in buffer.split(separator: "\n") {
                let parts = line.split(separator: " ")
                if parts.count == 2, parts[0] == "LISTENING", let port = Int(parts[1]) {
                    self.loaded = true
                    out.fileHandleForReading.readabilityHandler = nil
                    DispatchQueue.main.async { self.load(port: port) }
                    return
                }
            }
        }

        proc.terminationHandler = { [weak self] _ in
            guard let self else { return }
            DispatchQueue.main.async {
                if !self.loaded { self.fail("The local server exited before it was ready.") }
            }
        }

        do { try proc.run() } catch {
            fail("Could not launch the local server: \(error.localizedDescription)")
            return
        }
        server = proc

        // watchdog: if the LISTENING line never arrives, bail out
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, !self.loaded else { return }
            self.fail("The local server did not start within 15 seconds.")
        }
    }

    func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1240, height: 860)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Mac Cleaner"
        window.minSize = NSSize(width: 720, height: 480)
        window.delegate = self
        window.setFrameAutosaveName("MacCleanerMain")

        let conf = WKWebViewConfiguration()
        webView = WKWebView(frame: frame, configuration: conf)
        webView.autoresizingMask = [.width, .height]
        // match the dashboard's dark page color while the first paint loads
        window.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.05, alpha: 1)
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView = webView

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load(port: Int) {
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()   // SIGTERM; node exits promptly
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

// minimal main menu so ⌘Q/⌘W/⌘C/⌘V work as expected
let mainMenu = NSMenu()
let appItem = NSMenuItem()
mainMenu.addItem(appItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "About Mac Cleaner", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(withTitle: "Hide Mac Cleaner", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(withTitle: "Quit Mac Cleaner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu

let editItem = NSMenuItem()
mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu

let windowItem = NSMenuItem()
mainMenu.addItem(windowItem)
let windowMenu = NSMenu(title: "Window")
windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
windowItem.submenu = windowMenu
app.mainMenu = mainMenu

app.run()
