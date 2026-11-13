import RemiKit
import RemiUI
import SwiftUI

/// What a session screen needs to offer the terminal and files panes (#1639). The default is
/// chat only, which draws no switcher and no menu entries.
struct SessionPanes {
    var availability = RemiPaneAvailability(ack: nil, isConnected: false)
    var terminal: TerminalViewController?
    var download: FileDownloadFlow?
    var openTerminal: () -> MachineStore.PaneStart = { .blocked("Not available.") }
    var leaveTerminal: () -> Void = {}
    var tick: () -> Void = {}
    var beginDownload: (String) -> MachineStore.PaneStart = { _ in .blocked("Not available.") }
    var cancelDownload: () -> Void = {}
    var discardDownload: () -> Void = {}

    static var chatOnly: SessionPanes { SessionPanes() }
}

/// A picker between the panes a machine offers. It is not drawn when only chat is offered.
struct PanePicker: View {
    let offered: [PhoneSessionPane]
    @Binding var selection: PhoneSessionPane

    var body: some View {
        if offered.count > 1 {
            Picker("View", selection: $selection) {
                ForEach(offered, id: \.self) { pane in
                    Text(Self.title(pane)).tag(pane)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    static func title(_ pane: PhoneSessionPane) -> LocalizedStringKey {
        switch pane {
        case .chat: "Chat"
        case .terminal: "Terminal"
        case .files: "Files"
        }
    }

    static func systemImage(_ pane: PhoneSessionPane) -> String {
        switch pane {
        case .chat: "bubble.left.and.bubble.right"
        case .terminal: "terminal"
        case .files: "arrow.down.doc"
        }
    }
}

/// A read-only terminal. It opens the view when it appears and closes it when it goes away.
struct TerminalPane: View {
    let panes: SessionPanes
    @State private var startIssue: String?

    var body: some View {
        Group {
            if let reason = panes.availability.terminal.reason {
                ContentUnavailableView(
                    "Terminal not available", systemImage: "terminal", description: Text(reason))
            } else {
                content
            }
        }
        .task {
            guard panes.availability.terminal.isAvailable else { return }
            start()
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                panes.tick()
            }
        }
        .onDisappear { panes.leaveTerminal() }
    }

    private func start() {
        if case .blocked(let reason) = panes.openTerminal() { startIssue = reason } else { startIssue = nil }
    }

    @ViewBuilder
    private var content: some View {
        if let startIssue {
            retry(startIssue)
        } else if let controller = panes.terminal {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                Label("Read only. To answer or type, use the chat.", systemImage: "eye")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let screen = controller.screen {
                    RemiTerminalScreenView(snapshot: screen)
                        .opacity(Self.isOpen(controller) ? 1 : 0.55)
                }
                if let status = controller.statusText {
                    if controller.isActive {
                        HStack { ProgressView().controlSize(.small); Text(status) }
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        retry(status)
                    }
                }
            }
            .padding(RemiTheme.Spacing.m)
        } else {
            ProgressView("Opening the terminal").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private static func isOpen(_ controller: TerminalViewController) -> Bool {
        if case .open = controller.state { return true }
        return false
    }

    private func retry(_ message: String) -> some View {
        VStack(spacing: RemiTheme.Spacing.s) {
            Text(message).font(.subheadline).multilineTextAlignment(.center)
            Button("Try again", systemImage: "arrow.clockwise") { start() }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .padding(RemiTheme.Spacing.m)
    }
}

/// Download by path. Leaving the pane cancels a running download and discards its bytes.
struct FilesPane: View {
    let panes: SessionPanes
    @State private var startIssue: String?

    var body: some View {
        Group {
            if let reason = panes.availability.files.reason {
                ContentUnavailableView("Files not available", systemImage: "arrow.down.doc", description: Text(reason))
            } else {
                RemiFileDownloadView(
                    flow: panes.download,
                    startIssue: startIssue,
                    onStart: { path in
                        switch panes.beginDownload(path) {
                        case .started: startIssue = nil
                        case .blocked(let reason): startIssue = reason
                        case .invalidPath(let issue): startIssue = issue.text
                        }
                    },
                    onCancel: panes.cancelDownload,
                    onDiscard: panes.discardDownload)
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                panes.tick()
            }
        }
        .onDisappear { panes.discardDownload() }
    }
}
