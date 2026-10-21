import RemiUI
import SwiftUI

/// The phase 2 drawer body: an Inbox row, the sessions grouped Needs you, Active and
/// Recent, and a bar of actions. Intentionally minimal; the next phase replaces it.
/// It takes plain values and closures and never reads the store.
struct PhoneDrawerView: View {
    let sessions: [RemiSessionSummary]
    let questionCount: Int
    let destination: PhoneShellDestination
    let canCreateSession: Bool
    let onClose: () -> Void
    let onSelectInbox: () -> Void
    let onSelectSession: (RemiSessionSummary) -> Void
    let onNewSession: () -> Void
    let onAddMachine: () -> Void
    let onPreferences: () -> Void

    @Environment(\.phoneDrawerBlocksTaps) private var blocksTaps
    @Environment(\.phoneDrawerOrderFrozen) private var orderFrozen
    @Environment(\.phoneDrawerIsOpen) private var isOpen
    /// The grouping as it was when the order last moved freely; `displayed` is what the
    /// list shows. Both are memoized here so a body pass does not regroup the sessions.
    @State private var snapshot: RemiSessionGrouping
    @State private var displayed: RemiSessionGrouping
    @AccessibilityFocusState private var headerFocused: Bool

    init(
        sessions: [RemiSessionSummary],
        questionCount: Int,
        destination: PhoneShellDestination,
        canCreateSession: Bool,
        onClose: @escaping () -> Void,
        onSelectInbox: @escaping () -> Void,
        onSelectSession: @escaping (RemiSessionSummary) -> Void,
        onNewSession: @escaping () -> Void,
        onAddMachine: @escaping () -> Void,
        onPreferences: @escaping () -> Void
    ) {
        self.sessions = sessions
        self.questionCount = questionCount
        self.destination = destination
        self.canCreateSession = canCreateSession
        self.onClose = onClose
        self.onSelectInbox = onSelectInbox
        self.onSelectSession = onSelectSession
        self.onNewSession = onNewSession
        self.onAddMachine = onAddMachine
        self.onPreferences = onPreferences
        let grouping = RemiSessionGrouping(sessions: sessions)
        _snapshot = State(initialValue: grouping)
        _displayed = State(initialValue: grouping)
    }

    private var selectedKey: RemiSessionKey? {
        PhoneShellState(destination: destination).selectedSessionKey
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            list
            Divider()
            PhoneDrawerActions(
                canCreateSession: canCreateSession,
                onNewSession: { if !blocksTaps { onNewSession() } },
                onAddMachine: { if !blocksTaps { onAddMachine() } },
                onPreferences: { if !blocksTaps { onPreferences() } }
            )
        }
        .onChange(of: sessions) { _, _ in refresh() }
        .onChange(of: orderFrozen) { _, _ in refresh() }
        .onChange(of: isOpen) { _, open in
            if open { headerFocused = true }
        }
        .onAppear { if isOpen { headerFocused = true } }
    }

    /// While the order is frozen, rows keep the position they had; once it is free the
    /// list takes the live order and that becomes the next snapshot.
    private func refresh() {
        let live = RemiSessionGrouping(sessions: sessions)
        if orderFrozen {
            displayed = live.frozen(to: snapshot)
        } else {
            snapshot = live
            displayed = live
        }
    }

    private var header: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            Text("Remi")
                .font(.title2.weight(.bold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
                .accessibilitySortPriority(1)
                .accessibilityFocused($headerFocused)
            Button {
                if !blocksTaps { onClose() }
            } label: {
                Image(systemName: "xmark")
                    .frame(
                        width: RemiTheme.Size.minimumTapTarget,
                        height: RemiTheme.Size.minimumTapTarget
                    )
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close menu")
        }
        .padding(.leading, RemiTheme.Spacing.m)
        .padding(.trailing, RemiTheme.Spacing.xs)
        .padding(.vertical, RemiTheme.Spacing.xxs)
    }

    private var list: some View {
        let groups = displayed
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                PhoneDrawerInboxRow(
                    count: questionCount,
                    isSelected: destination == .inbox,
                    action: { if !blocksTaps { onSelectInbox() } }
                )
                section("Needs you", groups.needsYou)
                section("Active", groups.active)
                section("Recent", groups.recent)
            }
            .padding(.horizontal, RemiTheme.Spacing.xs)
        }
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, _ rows: [RemiSessionSummary]) -> some View {
        if !rows.isEmpty {
            Text(title)
                .font(RemiTheme.Typography.eyebrow)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .padding(.horizontal, RemiTheme.Spacing.s)
                .padding(.top, RemiTheme.Spacing.s)
                .accessibilityAddTraits(.isHeader)
            ForEach(rows, id: \.key) { session in
                PhoneDrawerSessionRow(
                    session: session,
                    isSelected: selectedKey == session.key,
                    action: { if !blocksTaps { onSelectSession(session) } }
                )
            }
        }
    }
}

private struct PhoneDrawerInboxRow: View {
    let count: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.s) {
                Image(systemName: "tray")
                Text("Inbox")
                Spacer(minLength: RemiTheme.Spacing.xs)
                if count > 0 { PhoneDrawerCountBadge(count: count) }
            }
            .font(.body)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .padding(.vertical, RemiTheme.Spacing.xs)
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .background(isSelected ? RemiTheme.Color.elevatedSurface : .clear, in: .rect(cornerRadius: RemiTheme.Radius.control))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

private struct PhoneDrawerSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: RemiTheme.Spacing.s) {
                texts
                Spacer(minLength: RemiTheme.Spacing.xs)
                indicator
            }
            .padding(.horizontal, RemiTheme.Spacing.s)
            .padding(.vertical, RemiTheme.Spacing.xs)
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .background(isSelected ? RemiTheme.Color.elevatedSurface : .clear, in: .rect(cornerRadius: RemiTheme.Radius.control))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var presentation: PhoneDrawerSessionPresentation {
        PhoneDrawerSessionPresentation(session: session)
    }

    private var texts: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
            Text(session.name)
                .font(.body)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            Text(presentation.subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        }
    }

    @ViewBuilder
    private var indicator: some View {
        if session.openQuestionCount > 0 {
            PhoneDrawerCountBadge(count: session.openQuestionCount)
        } else {
            Circle()
                .fill(Color.secondary.opacity(session.isLive ? 0.7 : 0.3))
                .frame(width: RemiTheme.Size.statusDot, height: RemiTheme.Size.statusDot)
                .accessibilityHidden(true)
        }
    }
}

private struct PhoneDrawerCountBadge: View {
    let count: Int

    var body: some View {
        Text(count, format: .number)
            .font(.caption.weight(.bold))
            .foregroundStyle(RemiTheme.Color.attentionInk)
            .padding(.horizontal, RemiTheme.Spacing.xs)
            .padding(.vertical, RemiTheme.Spacing.xxs)
            .background(RemiTheme.Color.attention, in: .capsule)
            .accessibilityLabel(count == 1 ? "1 question waiting" : "\(count) questions waiting")
    }
}

private struct PhoneDrawerActions: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let canCreateSession: Bool
    let onNewSession: () -> Void
    let onAddMachine: () -> Void
    let onPreferences: () -> Void

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    newSessionButton
                    labeledButton("Add machine", systemImage: "desktopcomputer.and.arrow.down", action: onAddMachine)
                    labeledButton("Preferences", systemImage: "gearshape", action: onPreferences)
                }
            } else {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    newSessionButton
                    iconButton("Add machine", systemImage: "desktopcomputer.and.arrow.down", hint: "Opens pairing", action: onAddMachine)
                    iconButton("Preferences", systemImage: "gearshape", hint: "Opens preferences", action: onPreferences)
                }
            }
        }
        .padding(RemiTheme.Spacing.s)
    }

    private var newSessionButton: some View {
        Button(action: onNewSession) {
            HStack {
                Label("New session", systemImage: "plus.rectangle.on.folder")
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.glassProminent)
        .tint(RemiTheme.Color.attention)
        .foregroundStyle(RemiTheme.Color.attentionInk)
        .disabled(!canCreateSession)
        .accessibilityHint(canCreateSession ? "Starts a session on a connected machine" : "Connect a machine first")
    }

    private func iconButton(_ title: LocalizedStringKey, systemImage: String, hint: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .frame(width: RemiTheme.Size.minimumTapTarget, height: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(title)
        .accessibilityHint(hint)
    }

    private func labeledButton(_ title: LocalizedStringKey, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
    }
}
