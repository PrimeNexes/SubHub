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
                Section("Agents that can use your subs") {
                    ForEach(s.agents.filter(\.installed)) { a in
                        Row(icon: a.id, title: a.name, subtitle: a.connected ? "Can hand work to your subs" : "Off · can't use your subs") {
                            Toggle("", isOn: Binding(get: { a.connected }, set: { on in Task { await hub.subhub([on ? "connect" : "disconnect", a.id]) } }))
                                .labelsHidden().toggleStyle(.switch)
                        }
                        .id("agent-" + a.id)
                    }
                }
                Section("Subs · \(s.subs.filter { $0.ready && $0.on }.count) ready") {
                    ForEach(s.subs) { sub in
                        Row(icon: sub.provider, title: sub.name, subtitle: sub.problem ?? "\(sub.email) · \(sub.label)", warn: sub.problem != nil && sub.on) {
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
                    if hub.installed { Button("Update SubHub") { Task { await hub.install() } } }
                } label: { Label("Add", systemImage: "plus") }
            }
        }
        .alert("SubHub", isPresented: Binding(get: { hub.message != nil }, set: { if !$0 { hub.message = nil } })) {
            Button("OK") {}
        } message: { Text(hub.message ?? "") }
        .task { await hub.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await hub.refresh() } }
    }
}

struct Row<Trailing: View>: View {
    let icon: String; let title: String; let subtitle: String; var warn = false
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 12) {
            if let img = providerIcon(icon) { Image(nsImage: img).resizable().frame(width: 28, height: 28) }
            else { Image(systemName: "sparkles").frame(width: 28, height: 28).foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.callout).foregroundStyle(warn ? .red : .secondary).lineLimit(1).help(subtitle)
            }
            Spacer()
            trailing
        }
        .padding(.vertical, 2)
    }
}
