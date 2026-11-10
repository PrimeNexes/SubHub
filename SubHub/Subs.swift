import AppKit
import Foundation

// SubHub.app is only setup and status. Everything else is the `subhub` script from the plugin
// (plugins/subhub/bin/subhub), which every agent uses; the app runs it and shows what it says.

let home = NSHomeDirectory()
let engine = home + "/.subhub/bin/subhub"
/// The plugin folder inside the app, copied at build time: what Install sets up.
let bundledRepo = Bundle.main.resourcePath.map { $0 + "/subhub" } ?? ""

struct SubRow: Decodable, Identifiable {
    var name: String; var provider: String; var folder: String; var email: String; var label: String; var state: String; var on: Bool
    var id: String { name }
    var ready: Bool { state == "ok" }
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
struct Status: Decodable { var version: String; var subs: [SubRow]; var agents: [AgentRow]; var found: [FoundRow] }

@MainActor @Observable final class Hub {
    var status: Status?
    var installed: Bool { FileManager.default.isExecutableFile(atPath: engine) }
    var busy = false
    var message: String?

    func refresh(force: Bool = false) async {
        guard installed else { status = nil; return }
        busy = true; defer { busy = false }
        let r = await run(engine, force ? ["status", "--json", "--refresh"] : ["status", "--json"])
        status = try? JSONDecoder().decode(Status.self, from: Data(r.out.utf8))
        if status == nil { message = "subhub status didn't answer: \(r.err.prefix(300))" }
    }

    /// Runs a subhub command, then refreshes.
    func subhub(_ args: [String]) async {
        busy = true
        let r = await run(engine, args, timeout: 120)
        busy = false
        if r.code != 0 { message = (r.err.isEmpty ? r.out : r.err).trimmingCharacters(in: .whitespacesAndNewlines) }
        await refresh()
    }

    /// Install (or update) from the copy inside the app: puts subhub on PATH and connects every agent here.
    func install() async {
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
