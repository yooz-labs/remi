import RemiUI
import SwiftUI

/// The phase 2 drawer body: an Inbox row, the sessions grouped Needs you, Active and
/// Recent, and a bar of actions. Intentionally minimal; the next phase replaces it.
/// It takes plain values and closures and never reads the store.
struct PhoneDrawerView: View {
    let sessions: [RemiSessionSummary]
    let questionCount: Int
    let destination: PhoneShellDestination
    /// True while the drawer is open. The session order freezes while it is.
    let isPresented: Bool
    let canCreateSession: Bool
    let onSelectInbox: () -> Void
    let onSelectSession: (RemiSessionSummary) -> Void
    let onNewSession: () -> Void
    let onAddMachine: () -> Void
    let onPreferences: () -> Void

    @State private var snapshot: RemiSessionGrouping
    @AccessibilityFocusState private var headerFocused: Bool

    init(
        sessions: [RemiSessionSummary],
        questionCount: Int,
        destination: PhoneShellDestination,
        isPresented: Bool,
        canCreateSession: Bool,
        onSelectInbox: @escaping () -> Void,
        onSelectSession: @escaping (RemiSessionSummary) -> Void,
        onNewSession: @escaping () -> Void,
        onAddMachine: @escaping () -> Void,
        onPreferences: @escaping () -> Void
    ) {
        self.sessions = sessions
        self.questionCount = questionCount
        self.destination = destination
        self.isPresented = isPresented
        self.canCreateSession = canCreateSession
        self.onSelectInbox = onSelectInbox
        self.onSelectSession = onSelectSession
        self.onNewSession = onNewSession
        self.onAddMachine = onAddMachine
        self.onPreferences = onPreferences
        _snapshot = State(initialValue: RemiSessionGrouping(sessions: sessions))
    }

    private var grouping: RemiSessionGrouping {
        let live = RemiSessionGrouping(sessions: sessions)
        return isPresented ? live.frozen(to: snapshot) : live
    }

    private var selectedSessionID: String? {
        if case .session(let route) = destination { return route.sessionID }
        return nil
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            list
            Divider()
            PhoneDrawerActions(
                canCreateSession: canCreateSession,
                onNewSession: onNewSession,
                onAddMachine: onAddMachine,
                onPreferences: onPreferences
            )
        }
        .onChange(of: sessions) { _, latest in
            if !isPresented { snapshot = RemiSessionGrouping(sessions: latest) }
        }
        .onChange(of: isPresented) { _, presented in
            if presented { headerFocused = true }
        }
    }

    private var header: some View {
        Text("Remi")
            .font(.title2.weight(.bold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.m)
            .padding(.vertical, RemiTheme.Spacing.s)
            .accessibilityAddTraits(.isHeader)
            .accessibilityFocused($headerFocused)
    }

    private var list: some View {
        let groups = grouping
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                PhoneDrawerInboxRow(
                    count: questionCount,
                    isSelected: destination == .inbox,
                    action: onSelectInbox
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
            ForEach(rows) { session in
                PhoneDrawerSessionRow(
                    session: session,
                    isSelected: selectedSessionID == session.id,
                    action: { onSelectSession(session) }
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
    let canCreateSession: Bool
    let onNewSession: () -> Void
    let onAddMachine: () -> Void
    let onPreferences: () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: RemiTheme.Spacing.xs) { buttons }
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) { buttons }
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .padding(RemiTheme.Spacing.s)
    }

    @ViewBuilder private var buttons: some View {
        Button("New session", systemImage: "plus.rectangle.on.folder", action: onNewSession)
            .disabled(!canCreateSession)
        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down", action: onAddMachine)
        Button("Preferences", systemImage: "gearshape", action: onPreferences)
    }
}
