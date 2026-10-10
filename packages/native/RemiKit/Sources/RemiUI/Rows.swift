import SwiftUI

public struct RemiSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let session: RemiSessionSummary

    public init(session: RemiSessionSummary) { self.session = session }

    public var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            RoundedRectangle(cornerRadius: 2)
                .fill(session.status == .needsYou ? RemiTheme.Color.attention : .clear)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                        Text(session.name).font(.headline)
                        RemiStatusBadge(status: session.status)
                    }
                } else {
                    HStack {
                        Text(session.name).font(.headline).lineLimit(1)
                        Spacer(minLength: RemiTheme.Spacing.xs)
                        RemiStatusBadge(status: session.status)
                    }
                }

                Text("\(session.machineName) / \(session.project)")
                    .font(RemiTheme.Typography.code)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)

                if let lastMessage = session.lastMessage {
                    Text(lastMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                }

                HStack {
                    Text(session.harness).font(.caption2.weight(.semibold)).textCase(.uppercase)
                    if session.canResume {
                        Text(storedSessionLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(session.isResuming ? Color.primary : .secondary)
                    }
                    Spacer()
                    if session.openQuestionCount > 0 {
                        Label("\(session.openQuestionCount)", systemImage: "questionmark.bubble.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(RemiTheme.Color.attentionInk)
                            .padding(.horizontal, RemiTheme.Spacing.xs)
                            .padding(.vertical, RemiTheme.Spacing.xxxs)
                            .background(RemiTheme.Color.attention, in: Capsule())
                    }
                }
                .foregroundStyle(.secondary)

                if let activity = session.lastActivityDate {
                    Text("Updated \(activity, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }

                if let resumeError = session.resumeError {
                    Text(resumeError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, RemiTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    private var storedSessionLabel: String {
        if session.isResuming { return "Resuming…" }
        guard let identity = session.resumeIdentity else { return "Stored" }
        return "Stored · \(identity)"
    }
}

private extension RemiSessionSummary {
    var lastActivityDate: Date? {
        guard let lastActivity else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(lastActivity))
            ?? (try? Date.ISO8601FormatStyle().parse(lastActivity))
    }
}

public struct RemiMachineRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let machine: RemiMachineSummary

    public init(machine: RemiMachineSummary) { self.machine = machine }

    public var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(machine.reachability == .waitingForApproval ? Color.primary : .secondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(machine.name).font(.headline)
                Text(machine.address).font(RemiTheme.Typography.code).foregroundStyle(.secondary)
                Text(statusText).font(.caption).foregroundStyle(.secondary)

                if dynamicTypeSize.isAccessibilitySize {
                    MachineMetadata(transport: machine.transport, sessionCount: machine.sessionCount)
                        .padding(.top, RemiTheme.Spacing.xxs)
                }
            }

            Spacer(minLength: RemiTheme.Spacing.xs)

            if !dynamicTypeSize.isAccessibilitySize {
                MachineMetadata(transport: machine.transport, sessionCount: machine.sessionCount)
            }
        }
        .padding(.vertical, RemiTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch machine.reachability {
        case .connected: "desktopcomputer"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .unreachable: "desktopcomputer.trianglebadge.exclamationmark"
        case .waitingForApproval: "person.badge.clock"
        }
    }

    private var statusText: LocalizedStringKey {
        switch machine.reachability {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .unreachable: "Unreachable"
        case .waitingForApproval: "Waiting for approval"
        }
    }
}

private struct MachineMetadata: View {
    let transport: RemiTransport
    let sessionCount: Int

    var body: some View {
        VStack(alignment: .trailing, spacing: RemiTheme.Spacing.xxs) {
            Text(transport.rawValue).font(.caption2.weight(.semibold)).textCase(.uppercase)
            Text(sessionCount == 1 ? "1 session" : "\(sessionCount) sessions")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
