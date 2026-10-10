import AppKit
import RemiKit
import RemiUI
import SwiftUI

struct MacLiveNeedsYouMenu: View {
    @Environment(\.openWindow) private var openWindow
    @State private var notificationRouter = MacNotificationRouter.shared
    let store: MachineStore

    var body: some View {
        let groups = pendingGroups
        let questionCount = groups.reduce(0) { $0 + $1.items.count }

        VStack(spacing: 0) {
            MacNeedsYouHeader(
                questionCount: questionCount,
                machineCount: groups.count
            )

            Divider()

            if groups.isEmpty {
                MacNeedsYouEmptyState()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                        ForEach(groups) { group in
                            MacNeedsYouMachineGroup(
                                group: group,
                                onAnswer: answer,
                                onSubmit: submit,
                                onCancel: cancel,
                                onOpen: { open($0.destination) }
                            )
                        }
                    }
                    .padding(RemiTheme.Spacing.m)
                }
                .scrollIndicators(.visible)
            }

            Divider()
            MacNeedsYouFooter(onOpen: { open(nil) })
        }
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 460)
        .frame(minHeight: 190, idealHeight: groups.isEmpty ? 220 : 520, maxHeight: 660)
        .background(.background)
    }

    private var pendingGroups: [RemiPendingQuestionGroup] {
        RemiPendingQuestionPresentation.groups(
            machines: store.machines,
            viewsBySession: store.sessionViewsBySession
        )
    }

    private func answer(_ item: RemiPendingQuestionItem, value: String) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: value,
            claudeSessionId: item.claudeSessionID
        )
    }

    private func submit(_ item: RemiPendingQuestionItem, selections: [RemiQuestionStepSelection]) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: "",
            claudeSessionId: item.claudeSessionID,
            selections: selections.compactMap { selection in
                guard let questionIndex = Int(selection.stepID) else { return nil }
                return AnswerSelection(
                    questionIndex: questionIndex,
                    optionIndices: selection.optionIDs.compactMap(Int.init).sorted(),
                    text: selection.text
                )
            }
        )
    }

    private func cancel(_ item: RemiPendingQuestionItem) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: "",
            claudeSessionId: item.claudeSessionID,
            cancel: true
        )
    }

    private func open(_ destination: RemiNavigationDestination?) {
        notificationRouter.destination = destination
        openWindow(id: "main")
        NSApp.activate()
    }
}

private struct MacNeedsYouMachineGroup: View {
    let group: RemiPendingQuestionGroup
    let onAnswer: (RemiPendingQuestionItem, String) -> Void
    let onSubmit: (RemiPendingQuestionItem, [RemiQuestionStepSelection]) -> Void
    let onCancel: (RemiPendingQuestionItem) -> Void
    let onOpen: (RemiPendingQuestionItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            MacNeedsYouMachineHeader(group: group)
            ForEach(group.items) { item in
                MacNeedsYouQuestionItem(
                    item: item,
                    onAnswer: { onAnswer(item, $0) },
                    onSubmit: { onSubmit(item, $0) },
                    onCancel: { onCancel(item) },
                    onOpen: { onOpen(item) }
                )
            }
        }
    }
}

private struct MacNeedsYouMachineHeader: View {
    let group: RemiPendingQuestionGroup

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            Image(systemName: icon)
                .foregroundStyle(group.reachability == .connected ? Color.secondary : RemiTheme.Color.attentionInk)
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(group.machineName).font(.subheadline.weight(.semibold))
                Text("\(group.transport.rawValue.capitalized) · \(group.address)")
                    .font(RemiTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: RemiTheme.Spacing.xs)
            Text(statusLabel.capitalized)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(
                    group.reachability == .connected ? Color.secondary : RemiTheme.Color.attentionInk
                )
                .padding(.horizontal, RemiTheme.Spacing.xs)
                .padding(.vertical, RemiTheme.Spacing.xxxs)
                .background(
                    group.reachability == .connected
                        ? Color.secondary.opacity(0.12)
                        : RemiTheme.Color.attention,
                    in: Capsule()
                )
            Text(group.items.count, format: .number)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(group.machineName), \(statusLabel), \(group.items.count) pending requests")
    }

    private var icon: String {
        switch group.reachability {
        case .connected: "desktopcomputer"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .unreachable: "desktopcomputer.trianglebadge.exclamationmark"
        case .waitingForApproval: "person.badge.clock"
        }
    }

    private var statusLabel: String {
        switch group.reachability {
        case .connected: "connected"
        case .connecting: "connecting"
        case .unreachable: "unreachable"
        case .waitingForApproval: "waiting for approval"
        }
    }
}

private struct MacNeedsYouQuestionItem: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let item: RemiPendingQuestionItem
    let onAnswer: (String) -> Void
    let onSubmit: ([RemiQuestionStepSelection]) -> Void
    let onCancel: () -> Void
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: RemiTheme.Spacing.xs) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xxs))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RemiTheme.Spacing.xs))
            layout {
                Label(item.conversationName, systemImage: item.agentID == nil ? "person" : "person.2")
                if let projectName = item.projectName { Text(projectName) }
                if let harnessName = item.harnessName { Text(harnessName) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)

            RemiQuestionCard(
                model: item.model,
                onAnswer: onAnswer,
                onSubmit: onSubmit,
                onCancel: onCancel
            )

            Button("Open conversation", systemImage: "arrow.up.forward.app", action: onOpen)
                .buttonStyle(.glass)
                .accessibilityLabel("Open \(item.model.sessionName) conversation")
                .accessibilityHint("Opens this exact request in the Remi window")
        }
    }
}

private struct MacNeedsYouHeader: View {
    let questionCount: Int
    let machineCount: Int

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            Image(systemName: questionCount == 0 ? "checkmark" : "person.wave.2.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(questionCount == 0 ? Color.secondary : RemiTheme.Color.attentionInk)
                .frame(width: 38, height: 38)
                .background(
                    questionCount == 0 ? Color.secondary.opacity(0.12) : RemiTheme.Color.attention,
                    in: Circle()
                )

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text("Needs you")
                    .font(.headline)
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: RemiTheme.Spacing.s)

            if questionCount > 0 {
                Text(questionCount, format: .number)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, RemiTheme.Spacing.xs)
                    .padding(.vertical, RemiTheme.Spacing.xxxs)
                    .foregroundStyle(RemiTheme.Color.attentionInk)
                    .background(RemiTheme.Color.attention, in: Capsule())
                    .accessibilityLabel(
                        questionCount == 1 ? "1 pending request" : "\(questionCount) pending requests"
                    )
            }
        }
        .padding(RemiTheme.Spacing.m)
    }

    private var summary: String {
        guard questionCount > 0 else { return "All connected agents can continue." }
        let requestLabel = questionCount == 1 ? "request" : "requests"
        let machineLabel = machineCount == 1 ? "machine" : "machines"
        return "\(questionCount) \(requestLabel) across \(machineCount) \(machineLabel)"
    }
}

private struct MacNeedsYouFooter: View {
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            Button("Open Remi", systemImage: "macwindow", action: onOpen)
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .help("Open the Remi window (Shift-Command-O)")
                .accessibilityHint("Opens the main Remi window")
            Spacer()
            SettingsLink { Label("Settings", systemImage: "gearshape") }
                .help("Open Remi settings")
        }
        .buttonStyle(.plain)
        .frame(minHeight: RemiTheme.Size.minimumTapTarget)
        .contentShape(.rect)
        .padding(.horizontal, RemiTheme.Spacing.m)
    }
}

private struct MacNeedsYouEmptyState: View {
    var body: some View {
        ContentUnavailableView {
            Label("Nothing waiting", systemImage: "checkmark.circle")
        } description: {
            Text("Questions and permission requests will appear here when an agent needs you.")
        }
        .padding(RemiTheme.Spacing.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
