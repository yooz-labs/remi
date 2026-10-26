import RemiUI
import SwiftUI
import UniformTypeIdentifiers

/// What a session row's long-press menu holds: actions for the project, its other sessions on the
/// machine (most recent first), and the copy actions. Drawn by `PhoneProjectMenuOverlay`.
struct PhoneProjectMenuContent: View {
    let session: RemiSessionSummary
    let otherSessions: [RemiSessionSummary]
    let isLastKnown: Bool
    let machineLabel: String?
    /// True when the session's machine is connected, so Resume and New session here can work.
    let canRunOnMachine: Bool
    let onSelectOther: (RemiSessionSummary) -> Void
    let onResume: () -> Void
    let onNewSessionHere: () -> Void
    /// Hides the menu. Every choice calls it before it acts.
    let close: () -> Void

    var body: some View {
        // Scrolls only when the room offered is too short, like a list of many sessions.
        ViewThatFits(in: .vertical) {
            content
            ScrollView { content }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(session.project)
                .font(.headline)
                .lineLimit(1)
                .padding(.horizontal, RemiTheme.Spacing.m)
                .padding(.top, RemiTheme.Spacing.s)
                .padding(.bottom, RemiTheme.Spacing.xxs)
                .accessibilityAddTraits(.isHeader)

            if canRunOnMachine {
                action("New session here", systemImage: "plus.rectangle.on.folder", onNewSessionHere)
                if session.canResume {
                    action(session.isResuming ? "Resuming" : "Resume", systemImage: "play.fill", onResume)
                        .disabled(session.isResuming)
                }
            }

            if !otherSessions.isEmpty {
                separator
                Text("Other sessions")
                    .font(RemiTheme.Typography.eyebrow)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                    .padding(.horizontal, RemiTheme.Spacing.m)
                    .padding(.top, RemiTheme.Spacing.xxs)
                    .accessibilityAddTraits(.isHeader)
                ForEach(otherSessions, id: \.key) { other in
                    entry(other)
                }
            }

            separator
            action("Copy directory", systemImage: "doc.on.doc") { Self.copyLocally(session.projectPath) }
            action("Copy session ID", systemImage: "doc.on.doc") { Self.copyLocally(session.id) }
                .padding(.bottom, RemiTheme.Spacing.xxs)
        }
    }

    private var separator: some View {
        Divider().padding(.vertical, RemiTheme.Spacing.xxs)
    }

    private func action(
        _ title: LocalizedStringKey, systemImage: String, _ perform: @escaping () -> Void
    ) -> some View {
        Button {
            close()
            perform()
        } label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, RemiTheme.Spacing.m)
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func entry(_ other: RemiSessionSummary) -> some View {
        let row = PhoneDrawerSessionPresentation(
            session: other, isLastKnown: isLastKnown, machineLabel: machineLabel)
        return Button {
            close()
            onSelectOther(other)
        } label: {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(row.title).lineLimit(1)
                Text(Self.detail(for: other, subtitle: row.subtitle))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.m)
            .padding(.vertical, RemiTheme.Spacing.xxs)
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.accessibilityLabel)
    }

    /// What an entry says under its title: a running or waiting session says so, in words.
    private static func detail(for session: RemiSessionSummary, subtitle: String) -> String {
        switch session.status {
        case .needsYou: String(localized: "Needs you") + " · " + subtitle
        case .working: String(localized: "Working") + " · " + subtitle
        default: subtitle
        }
    }

    /// Local only, so Universal Clipboard does not sync a path or an id to other devices.
    private static func copyLocally(_ value: String) {
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: value]],
            options: [.localOnly: true]
        )
    }
}
