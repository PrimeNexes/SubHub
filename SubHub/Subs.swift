import AppKit
import Foundation

// SubHub.app is only setup and status. Everything else is the `subhub` script from the plugin
// (plugins/subhub/bin/subhub), which every agent uses; the app runs it and shows what it says.

let home = NSHomeDirectory()
let engine = home + "/.subhub/bin/subhub"
/// The plugin folder inside the app, copied at build time: what Install sets up.
let bundledRepo = Bundle.main.resourcePath.map { $0 + "/subhub" } ?? ""

/// What SubHub knows about whether a signed-in sub really works (from `subhub check` and from every real ask).
struct Health: Decodable { var state: String; var reason: String?; var resets: Double?; var usable: Bool? }

/// One limit window: how much is used and when it resets (from `subhub status --json`).
struct UsageWindow: Decodable { var id: String; var label: String; var group: String?; var used: Double; var resets: Double? }
struct Usage: Decodable { var windows: [UsageWindow]; var left: Double?; var text: String? }

struct SubRow: Decodable, Identifiable {
    var name: String; var provider: String; var folder: String; var email: String; var label: String; var state: String; var on: Bool
    var health: Health?
    var usage: Usage?
    /// "5h 26% used, resets 15:51 · 7d 5%", short enough for one line.
    var usageLine: String? {
        guard let w = usage?.windows, !w.isEmpty else { return nil }
        return w.map { x in
            let reset = x.resets.map { " until " + Date(timeIntervalSince1970: $0 / 1000).formatted(Calendar.current.isDateInToday(Date(timeIntervalSince1970: $0 / 1000)) ? .dateTime.hour().minute() : .dateTime.month(.abbreviated).day().hour().minute()) } ?? ""
            return "\(x.label) \(Int(x.used.rounded()))%\(reset)"
        }.joined(separator: " · ")
    }
    var id: String { name }
    var ready: Bool { state == "ok" }
    /// Signed in, and not known to be at its limit, out of credits, unauthorised or failing.
    var usable: Bool { ready && (health?.usable ?? true) }
    /// Why a signed-in sub doesn't work right now, or nil when it works or hasn't been tested.
    var healthNote: String? {
        guard ready, let h = health else { return nil }
        let what: String
        switch h.state {
        case "limit": what = "At its usage limit" + (h.resets.map { " until " + Date(timeIntervalSince1970: $0 / 1000).formatted(date: .omitted, time: .shortened) } ?? "")
        case "nocredits": what = "Out of credits or no plan"
        case "noauth": what = "Not authorised to run as a sub"
        case "failing": what = "Failing"
        default: return nil
        }
        let why = (h.reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return why.isEmpty ? what : "\(what): \(why)"
    }
    var problem: String? {
        switch state {
        case "ok": return nil
        case "signedout": return "Signed out"
        case "stopped": return "Ollama isn't running"
        case "missing": return "Its folder is gone"
        default: return state.hasPrefix("changed:") ? "Signed in as \(state.dropFirst(8)), not \(email)" : state
        }
    }
}
struct AgentRow: Decodable, Identifiable { var id: String; var name: String; var installed: Bool; var connected: Bool }
struct FoundRow: Decodable, Identifiable {
    var email: String; var org: String; var orgName: String; var type: String
    var id: String { email + "|" + org }
    var label: String { ["team", "enterprise"].contains(type) ? "Team · \(orgName)" : "Personal" }
}
struct Engine: Decodable { var drift: [String]? }
struct StatusTap: Decodable { var on: [String]; var off: [String] }
struct Status: Decodable { var version: String; var subs: [SubRow]; var agents: [AgentRow]; var found: [FoundRow]; var engine: Engine?; var statusline: StatusTap? }

/// The version of the plugin copy inside the app.
let bundledVersion: String = {
    guard let d = FileManager.default.contents(atPath: bundledRepo + "/plugins/subhub/plugin.json"),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return "" }
    return j["version"] as? String ?? ""
}()
/// True when version `a` is newer than `b` (numbers only: "0.8.0-alpha" counts as 0.8.0).
func newer(_ a: String, than b: String) -> Bool {
    let n = { (v: String) in v.split(separator: "-").first.map { $0.split(separator: ".").map { Int($0) ?? 0 } } ?? [] }
    let x = n(a), y = n(b)
    for i in 0..<3 { let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0; if p != q { return p > q } }
    return false
}

@MainActor @Observable final class Hub {
    var status: Status?
    var installed: Bool { FileManager.default.isExecutableFile(atPath: engine) }
    var busy = false
    var message: String?
    /// The app's copy is newer than the installed one. Update never installs an older copy over a newer one.
    var canUpdate: Bool { guard let v = status?.version else { return false }; return newer(bundledVersion, than: v) }
    private var stamp = ""
    /// Changes when `subhub` (in a terminal, or an agent) changed the settings or the subs, so the window follows.
    private func filesStamp() -> String {
        ["config.json", "registry.json", "usage.json"].map { f in
            ((try? FileManager.default.attributesOfItem(atPath: home + "/.subhub/" + f))?[.modificationDate] as? Date).map { String($0.timeIntervalSince1970) } ?? "-"
        }.joined(separator: "|")
    }
    func refreshIfChanged() async { if !busy, filesStamp() != stamp { await refresh() } }

    func refresh(force: Bool = false) async {
        guard installed else { status = nil; return }
        busy = true; defer { busy = false }
        let r = await run(engine, force ? ["status", "--json", "--refresh"] : ["status", "--json"])
        status = try? JSONDecoder().decode(Status.self, from: Data(r.out.utf8))
        if status == nil { message = "subhub status didn't answer: \(r.err.prefix(300))" }
        stamp = filesStamp()
    }

    /// Runs a subhub command, then refreshes.
    func subhub(_ args: [String], timeout: Double = 120, showOutput: Bool = false) async {
        busy = true
        let r = await run(engine, args, timeout: timeout)
        busy = false
        if r.code != 0 || showOutput { message = [r.out, r.err].filter { !$0.isEmpty }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        if message?.isEmpty == true { message = "subhub \(args.first ?? "") ended with exit \(r.code) and said nothing." }
        await refresh()
    }

    /// Install (or update) from the copy inside the app: puts subhub on PATH and connects every agent here.
    func install() async {
        if installed, let v = status?.version, !newer(bundledVersion, than: v) {
            message = "SubHub \(v) is installed. This app carries \(bundledVersion), which isn't newer, so there is nothing to update."
            return
        }
        busy = true
        let r = await run("/bin/sh", [bundledRepo + "/install.sh"], timeout: 300)
        busy = false
        if r.code != 0 { message = "Install failed:\n" + (r.err.isEmpty ? r.out : r.err) }
        await refresh(force: true)
    }

    /// Sign-ins are interactive: they run in Terminal, where the user sees the command first.
    func terminal(_ args: [String]) {
        let cmd = ([engine] + args).map(q).joined(separator: " ")
        let path = home + "/.subhub/signin.command"
        let text = "#!/bin/sh\nclear\necho 'SubHub will run: \(cmd.replacingOccurrences(of: "'", with: ""))'\n\(cmd)\necho\necho 'Done. Go back to SubHub and press Refresh.'\n"
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path)
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }
}

struct RunResult { var code: Int32; var out: String; var err: String }

func run(_ exe: String, _ args: [String], timeout: Double = 60) async -> RunResult {
    await withCheckedContinuation { cont in
        DispatchQueue.global().async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
            p.environment = env
            let out = Pipe(), err = Pipe()
            p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
            do { try p.run() } catch { cont.resume(returning: RunResult(code: -1, out: "", err: error.localizedDescription)); return }
            let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
            let o = out.fileHandleForReading.readDataToEndOfFile(), e = err.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit(); timer.cancel()
            cont.resume(returning: RunResult(code: p.terminationStatus, out: String(decoding: o, as: UTF8.self), err: String(decoding: e, as: UTF8.self)))
        }
    }
}

func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: #"'\''"#) + "'" }

/// The vendor's own app icon when it's installed, else nil (an SF Symbol is shown).
@MainActor func providerIcon(_ provider: String) -> NSImage? {
    let apps = ["claude": ["/Applications/Claude.app"], "codex": ["/Applications/Codex.app", "/Applications/ChatGPT.app"],
                "cursor": ["/Applications/Cursor.app"], "gemini": ["/Applications/Antigravity.app", "/Applications/Antigravity IDE.app"],
                "ollama": ["/Applications/Ollama.app"]][provider] ?? []
    return apps.first { FileManager.default.fileExists(atPath: $0) }.map { NSWorkspace.shared.icon(forFile: $0) }
}
