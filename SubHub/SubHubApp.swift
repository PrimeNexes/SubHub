import SwiftUI

@main
struct SubHubApp: App {
    @State private var hub = Hub()
    var body: some Scene {
        Window("SubHub", id: "main") { MainView().environment(hub).frame(minWidth: 520, minHeight: 420) }
            .windowResizability(.contentMinSize)
    }
}

/// Setup and status: subs, agents and accounts found on this Mac. The work is done by `subhub`.
struct MainView: View {
    @Environment(Hub.self) private var hub

    var body: some View {
        List {
            if !hub.installed {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Set up SubHub").font(.headline)
                        Text("Installs the subhub plugin for every AI agent on this Mac (Claude Code, Codex, Antigravity, Cursor) and finds every account you're signed in to. Agents can then hand work to your other subscriptions. Subs run with full access, and the calling agent decides what each may do.")
                            .font(.callout).foregroundStyle(.secondary)
                        Button("Install") { Task { await hub.install() } }.buttonStyle(.borderedProminent).disabled(hub.busy)
                    }.padding(.vertical, 6)
                }
            } else if let s = hub.status {
                if let tap = s.statusline, !tap.off.isEmpty, s.agents.contains(where: { $0.id == "claude" && $0.connected }) {
                    Section("Usage tracking") {
                        Text("Usage of the Claude account a Claude Code session runs on isn't tracked in \(tap.off.joined(separator: ", ")). Turn Claude Code off and on again here to add it.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                if let drift = s.engine?.drift, !drift.isEmpty {
                    Section("Needs attention") {
                        ForEach(drift, id: \.self) { Text($0).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
                    }
                }
                Section("Agents that can use your subs") {
                    ForEach(s.agents.filter(\.installed)) { a in
                        Row(icon: a.id, title: a.name, subtitle: a.connected ? "Can hand work to your subs" : "Off · can't use your subs") {
                            Toggle("", isOn: Binding(get: { a.connected }, set: { on in Task { await hub.subhub([on ? "connect" : "disconnect", a.id]) } }))
                                .labelsHidden().toggleStyle(.switch)
                        }
                        .id("agent-" + a.id)
                    }
                }
                Section("Subs · \(s.subs.filter { $0.usable && $0.on }.count) ready") {
                    ForEach(s.subs) { sub in
                        Row(icon: sub.provider, title: sub.name, subtitle: sub.problem ?? sub.healthNote ?? "\(sub.email) · \(sub.label)", warn: (sub.problem != nil || sub.healthNote != nil) && sub.on,
                            detail: sub.ready && sub.on ? (sub.usageLine.map { "Used: " + $0 } ?? (["cursor", "ollama"].contains(sub.provider) ? "Usage: not reported by \(sub.provider == "cursor" ? "Cursor" : "Ollama")" : "Usage: not known yet")) : nil,
                            meter: sub.ready && sub.on ? sub.usage?.left.map { 1 - $0 / 100 } : nil) {
                            if sub.on, sub.problem != nil, sub.state != "stopped" {
                                Button("Sign In") { hub.terminal(["signin", sub.name]) }.buttonStyle(.borderedProminent)
                            }
                            Toggle("", isOn: Binding(get: { sub.on }, set: { on in Task { await hub.subhub([on ? "on" : "off", sub.name]) } }))
                                .labelsHidden().toggleStyle(.switch).controlSize(.small)
                        }
                        .contextMenu {
                            Button("Sign In Again…") { hub.terminal(["signin", sub.name]) }
                            Button("Remove", role: .destructive) { Task { await hub.subhub(["remove", sub.name]) } }
                        }
                    }
                }
                if !s.found.isEmpty {
                    Section("Found on this Mac, not signed in yet") {
                        ForEach(s.found) { f in
                            Row(icon: "claude", title: f.email, subtitle: "Claude · \(f.label)") {
                                Button("Add") { hub.terminal(["signin", "claude", "--new", "--email", f.email]) }.buttonStyle(.borderedProminent)
                            }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .toolbar {
            ToolbarItem {
                Button { Task { await hub.refresh(force: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(hub.busy || !hub.installed).keyboardShortcut("r")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Claude Account or Organization…") { hub.terminal(["signin", "claude", "--new"]) }
                    if hub.installed {
                        Divider()
                        Button("Test Which Subs Work") { Task { await hub.subhub(["check"], timeout: 240) } }
                        Button("Update Agent CLIs and Models") { Task { await hub.subhub(["update"], timeout: 1800, showOutput: true) } }
                        if hub.canUpdate { Button("Update SubHub to \(bundledVersion)") { Task { await hub.install() } } }
                        else if let v = hub.status?.version { Text("SubHub \(v)") }
                    }
                } label: { Label("Add", systemImage: "plus") }
            }
        }
        .alert("SubHub", isPresented: Binding(get: { hub.message != nil }, set: { if !$0 { hub.message = nil } })) {
            Button("OK") {}
        } message: { Text(hub.message ?? "") }
        .task {
            await hub.refresh()
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(3)); await hub.refreshIfChanged() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await hub.refresh() } }
    }
}

struct Row<Trailing: View>: View {
    let icon: String; let title: String; let subtitle: String; var warn = false
    var detail: String? = nil
    /// Share of the tightest limit window used (0-1), drawn as a small bar.
    var meter: Double? = nil
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 12) {
            if let img = providerIcon(icon) { Image(nsImage: img).resizable().frame(width: 28, height: 28) }
            else { Image(systemName: "sparkles").frame(width: 28, height: 28).foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.callout).foregroundStyle(warn ? .red : .secondary).lineLimit(1).help(subtitle)
                if let detail {
                    HStack(spacing: 6) {
                        if let m = meter {
                            ProgressView(value: min(max(m, 0), 1)).progressViewStyle(.linear).frame(width: 60)
                                .tint(m >= 0.85 ? .red : m >= 0.6 ? .orange : .green)
                        }
                        Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).help(detail)
                    }
                }
            }
            Spacer()
            trailing
        }
        .padding(.vertical, 2)
    }
}
