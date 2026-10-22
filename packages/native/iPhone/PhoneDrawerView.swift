import RemiUI
import SwiftUI
import UIKit

/// The phase 2 drawer body: an Inbox row, the sessions grouped Needs you, Active and
/// Recent, and a bar of actions. Intentionally minimal; the next phase replaces it.
/// It takes plain values and closures and never reads the store.
struct PhoneDrawerView: View {
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let filter: PhoneDrawerFilter
    let questionCount: Int
    let destination: PhoneShellDestination
    let canCreateSession: Bool
    let onClose: () -> Void
    let onSelectAllMachines: () -> Void
    let onSelectMachine: (String) -> Void
    let onManageMachines: () -> Void
    let onResumeSession: (String, String) -> Void
    let onNewSessionHere: (String, String) -> Void
    let onSelectInbox: () -> Void
    let onSelectSession: (RemiSessionSummary) -> Void
    let onNewSession: () -> Void
    let onAddMachine: () -> Void
    let onPreferences: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.phoneDrawerBlocksTaps) private var blocksTaps
    @Environment(\.phoneDrawerOrderFrozen) private var orderFrozen
    @Environment(\.phoneDrawerIsOpen) private var isOpen
    /// The grouping as it was when the order last moved freely; `displayed` is what the
    /// list shows. Both are memoized here so a body pass does not regroup the sessions.
    @State private var snapshot: RemiSessionGrouping
    @State private var displayed: RemiSessionGrouping
    @State private var query = ""
    @AccessibilityFocusState private var headerFocused: Bool
    @FocusState private var searchFocused: Bool

    init(
        sessions: [RemiSessionSummary],
        machines: [RemiMachineSummary] = [],
        filter: PhoneDrawerFilter = .all,
        initialQuery: String = "",
        questionCount: Int,
        destination: PhoneShellDestination,
        canCreateSession: Bool,
        onClose: @escaping () -> Void,
        onSelectAllMachines: @escaping () -> Void = {},
        onSelectMachine: @escaping (String) -> Void = { _ in },
        onManageMachines: @escaping () -> Void = {},
        onResumeSession: @escaping (String, String) -> Void = { _, _ in },
        onNewSessionHere: @escaping (String, String) -> Void = { _, _ in },
        onSelectInbox: @escaping () -> Void,
        onSelectSession: @escaping (RemiSessionSummary) -> Void,
        onNewSession: @escaping () -> Void,
        onAddMachine: @escaping () -> Void,
        onPreferences: @escaping () -> Void
    ) {
        self.sessions = sessions
        self.machines = machines
        self.filter = filter
        self.questionCount = questionCount
        self.destination = destination
        self.canCreateSession = canCreateSession
        self.onClose = onClose
        self.onSelectAllMachines = onSelectAllMachines
        self.onSelectMachine = onSelectMachine
        self.onManageMachines = onManageMachines
        self.onResumeSession = onResumeSession
        self.onNewSessionHere = onNewSessionHere
        self.onSelectInbox = onSelectInbox
        self.onSelectSession = onSelectSession
        self.onNewSession = onNewSession
        self.onAddMachine = onAddMachine
        self.onPreferences = onPreferences
        _query = State(initialValue: initialQuery)
        var initialFilter: String?
        if case .machine(let key) = filter { initialFilter = key }
        let grouping = RemiSessionGrouping(
            sessions: RemiSessionFilter.apply(to: sessions, query: initialQuery, machineKey: initialFilter)
        )
        _snapshot = State(initialValue: grouping)
        _displayed = State(initialValue: grouping)
    }

    private var selectedKey: RemiSessionKey? {
        PhoneShellState(destination: destination).selectedSessionKey
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .background(dynamicTypeSize.isAccessibilitySize ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(.clear))
                .zIndex(1)
            if dynamicTypeSize.isAccessibilitySize {
                accessibilityColumn
            } else {
                regularColumn
            }
        }
        .onChange(of: sessions) { _, _ in refresh() }
        .onChange(of: orderFrozen) { _, _ in refresh() }
        // A new filter or query is not a reorder of what is on screen: show the result
        // at once instead of holding the old order.
        .onChange(of: filter) { _, _ in refresh(reordering: true) }
        .onChange(of: query) { _, _ in refresh(reordering: true) }
        .onChange(of: isOpen) { _, open in
            if open { headerFocused = true }
        }
        .onAppear { if isOpen { headerFocused = true } }
    }

    /// Normal sizes: the strip, problems and search stay pinned, the list scrolls, and the
    /// actions are pinned below it.
    private var regularColumn: some View {
        VStack(spacing: 0) {
            strip
            // While the keyboard is up, keep the strip and search and give the list the room.
            if !searchFocused { problemRows }
            if showsSearch { searchField }
            ScrollView { listContent }
                .scrollDismissesKeyboard(.interactively)
            if !searchFocused {
                Divider()
                actions
            }
        }
    }

    /// Accessibility sizes: the actions, strip, problems, search and list are one column
    /// that scrolls together, so every row is reachable however large the text is. The
    /// actions come first, under the header, so a long list never pushes them out of
    /// reach. Only the header is pinned, on a material.
    private var accessibilityColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !searchFocused {
                    actions
                    Divider().padding(.bottom, RemiTheme.Spacing.xs)
                }
                strip
                if !searchFocused { problemRows }
                if showsSearch { searchField }
                listContent
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var strip: some View {
        PhoneMachineStrip(
            machines: machines,
            filter: filter,
            onSelectAll: { if !blocksTaps { onSelectAllMachines() } },
            onSelectMachine: { if !blocksTaps { onSelectMachine($0) } },
            onManage: { if !blocksTaps { onManageMachines() } }
        )
    }

    private var problemRows: some View {
        PhoneMachineProblemRows(machines: machines, onManage: { if !blocksTaps { onManageMachines() } })
            .padding(.horizontal, RemiTheme.Spacing.m)
    }

    private var actions: some View {
        PhoneDrawerActions(
            canCreateSession: canCreateSession,
            onNewSession: { if !blocksTaps { onNewSession() } },
            onAddMachine: { if !blocksTaps { onAddMachine() } },
            onPreferences: { if !blocksTaps { onPreferences() } }
        )
    }

    private var filteredKey: String? {
        if case .machine(let key) = filter { return key }
        return nil
    }

    /// What each row needs to know about its machine, worked out once per list pass.
    private struct RowContext {
        let labels: [String: String]
        let lastKnown: Set<String>
        let connected: Set<String>
    }

    private var rowContext: RowContext {
        RowContext(
            labels: RemiMachineStripPresentation.uniqueLabels(for: machines),
            lastKnown: RemiMachineStripPresentation.lastKnownMachineIDs(in: machines),
            connected: Set(machines.filter { $0.reachability == .connected }.map(\.id))
        )
    }

    private var showsSearch: Bool { !sessions.isEmpty || !query.isEmpty }

    /// While the order is frozen, rows keep the position they had; once it is free the
    /// list takes the live order and that becomes the next snapshot.
    private func refresh(reordering: Bool = false) {
        let live = RemiSessionGrouping(
            sessions: RemiSessionFilter.apply(to: sessions, query: query, machineKey: filteredKey)
        )
        if orderFrozen && !reordering {
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
                // Capped at accessibility1: the header is pinned, so at the largest sizes it
                // would otherwise take a large part of the screen. The rest of the column keeps scaling.
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
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

    private var searchField: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Search sessions", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFocused)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: RemiTheme.Size.minimumTapTarget, height: RemiTheme.Size.minimumTapTarget)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, RemiTheme.Spacing.s)
        .padding(.trailing, RemiTheme.Spacing.s)
        .frame(minHeight: RemiTheme.Size.minimumTapTarget)
        .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.bottom, RemiTheme.Spacing.xxs)
    }

    private var listContent: some View {
        let groups = displayed
        let context = rowContext
        return LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
            PhoneDrawerInboxRow(
                count: questionCount,
                isSelected: destination == .inbox,
                action: { if !blocksTaps { onSelectInbox() } }
            )
            section("Needs you", groups.needsYou, context)
            section("Active", groups.active, context)
            section("Recent", groups.recent, context)
            if groups.isEmpty { emptyStateView }
        }
        .padding(.horizontal, RemiTheme.Spacing.xs)
    }

    private var emptyState: RemiDrawerEmptyState {
        RemiDrawerEmptyState.resolve(
            visibleSessionCount: displayed.flattened.count,
            query: query,
            isMachineFiltered: filteredKey != nil
        )
    }

    @ViewBuilder
    private var emptyStateView: some View {
        switch emptyState {
        case .content:
            EmptyView()
        case .nothing:
            if machines.isEmpty { firstRunHint }
        case .noMatch:
            noMatches
        case .machineEmpty:
            machineEmpty
        }
    }

    /// Before any machine is added the list has nothing to show and New session is
    /// disabled; say why and what to do.
    private var firstRunHint: some View {
        Text("Add a machine to see its sessions")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(RemiTheme.Spacing.m)
    }

    private var noMatches: some View {
        VStack(spacing: RemiTheme.Spacing.xs) {
            Text("No sessions match")
                .font(.headline)
            Text("Try a different search, or show all machines.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Clear search and filter") {
                query = ""
                if !blocksTaps { onSelectAllMachinesIfFiltered() }
            }
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .frame(maxWidth: .infinity)
        .padding(RemiTheme.Spacing.m)
        .accessibilityElement(children: .contain)
    }

    /// A filtered machine with no sessions yet. New session is offered only while that
    /// machine is connected, because only a connected machine can start one.
    private var machineEmpty: some View {
        let key = filteredKey ?? ""
        let context = rowContext
        let name = context.labels[key] ?? ""
        return VStack(spacing: RemiTheme.Spacing.xs) {
            Text("No sessions on \(name)")
                .font(.headline)
                .multilineTextAlignment(.center)
            if context.connected.contains(key) && canCreateSession {
                Button("New session", systemImage: "plus.rectangle.on.folder") {
                    if !blocksTaps { onNewSession() }
                }
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
            }
            Button("Show all machines") {
                if !blocksTaps { onSelectAllMachines() }
            }
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .frame(maxWidth: .infinity)
        .padding(RemiTheme.Spacing.m)
        .accessibilityElement(children: .contain)
    }

    private func onSelectAllMachinesIfFiltered() {
        if filteredKey != nil { onSelectAllMachines() }
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, _ rows: [RemiSessionSummary], _ context: RowContext) -> some View {
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
                    isLastKnown: context.lastKnown.contains(session.machineID),
                    machineLabel: context.labels[session.machineID],
                    canRunOnMachine: context.connected.contains(session.machineID),
                    action: { if !blocksTaps { onSelectSession(session) } },
                    onResume: { onResumeSession(session.machineID, session.id) },
                    onNewSessionHere: { onNewSessionHere(session.machineID, session.projectPath) }
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
    @ScaledMetric(relativeTo: .body) private var statusDotSize = RemiTheme.Size.statusDot
    let session: RemiSessionSummary
    let isSelected: Bool
    let isLastKnown: Bool
    let machineLabel: String?
    /// True when the session's machine is connected, so Resume and New session here can work.
    let canRunOnMachine: Bool
    let action: () -> Void
    let onResume: () -> Void
    let onNewSessionHere: () -> Void

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
        .contextMenu { menuItems }
    }

    private var presentation: PhoneDrawerSessionPresentation {
        PhoneDrawerSessionPresentation(session: session, isLastKnown: isLastKnown, machineLabel: machineLabel)
    }

    @ViewBuilder
    private var menuItems: some View {
        if session.canResume && canRunOnMachine {
            Button(session.isResuming ? "Resuming" : "Resume", systemImage: "play.fill", action: onResume)
                .disabled(session.isResuming)
        }
        if canRunOnMachine {
            Button("New session here", systemImage: "plus.rectangle.on.folder", action: onNewSessionHere)
        }
        Button("Copy directory", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = session.projectPath
        }
        Button("Copy session ID", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = session.id
        }
    }

    private var texts: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
            // Only the name is dimmed: the "Last known" caption and the attention badge
            // keep full contrast.
            Text(session.name)
                .font(.body)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .opacity(isLastKnown ? 0.75 : 1)
            Text(presentation.subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            if let resumeError = session.resumeError {
                Text(resumeError)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var indicator: some View {
        if session.openQuestionCount > 0 {
            PhoneDrawerCountBadge(count: session.openQuestionCount)
        } else {
            Circle()
                .fill(Color.secondary.opacity(session.isLive ? 0.7 : 0.3))
                .frame(width: statusDotSize, height: statusDotSize)
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

    private var presentation: RemiDrawerActionsPresentation {
        RemiDrawerActionsPresentation(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    var body: some View {
        Group {
            if presentation.hasMenu {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    newSessionButton
                    moreMenu
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

    /// At accessibility sizes: one labeled button that opens the actions that left the row.
    private var moreMenu: some View {
        Menu {
            ForEach(presentation.menu, id: \.self) { action in
                menuItem(action)
            }
        } label: {
            HStack {
                Label("More", systemImage: "ellipsis")
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
    }

    @ViewBuilder
    private func menuItem(_ action: RemiDrawerAction) -> some View {
        switch action {
        case .addMachine:
            Button("Add machine", systemImage: "desktopcomputer.and.arrow.down", action: onAddMachine)
                .accessibilityHint("Opens pairing")
        case .preferences:
            Button("Preferences", systemImage: "gearshape", action: onPreferences)
                .accessibilityHint("Opens preferences")
        case .newSession:
            EmptyView()
        }
    }

    private var newSessionButton: some View {
        Button(action: onNewSession) {
            HStack {
                Label("New session", systemImage: "plus.rectangle.on.folder")
                    .multilineTextAlignment(.leading)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : nil)
                    .minimumScaleFactor(0.8)
                    .fixedSize(horizontal: false, vertical: true)
                if dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
            .contentShape(.rect)
        }
        .buttonStyle(.glassProminent)
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
}
