import Foundation

/// How the drawer shows its machines, kept apart from the view so it can be tested.
///
/// The layout depends only on how many machines there are and whether the text size is
/// an accessibility size. Problems are the machines that need the person to act.
public enum RemiMachineStripPresentation {
    public enum Layout: Equatable, Sendable {
        /// No machines: nothing to show.
        case none
        /// Exactly one machine: a single line, at any text size.
        case header(RemiMachineSummary)
        /// Two or more machines at an accessibility text size: a menu, not chips.
        case menu
        /// Two to four machines: an All chip and one chip each.
        case chips
        /// Five or more machines: the same chips in a horizontal scroll.
        case scrollingChips
    }

    /// A neutral dot shape for a machine's reachability. The shapes differ so state is
    /// not carried by color alone; `accessibilityWord` says it in words.
    public enum DotStyle: Equatable, Sendable {
        case filled
        case progress
        case hollow
        case dashed

        public var accessibilityWord: String {
            switch self {
            case .filled: "connected"
            case .progress: "connecting"
            case .hollow: "offline"
            case .dashed: "waiting for approval"
            }
        }
    }

    /// A machine that needs the person to act. Connecting is not a problem.
    public enum Problem: Equatable, Sendable, Identifiable {
        case unreachable(RemiMachineSummary)
        case waitingForApproval(RemiMachineSummary)

        public var machine: RemiMachineSummary {
            switch self {
            case .unreachable(let machine), .waitingForApproval(let machine): machine
            }
        }

        public var id: String {
            switch self {
            case .unreachable(let machine): "unreachable|\(machine.id)"
            case .waitingForApproval(let machine): "approval|\(machine.id)"
            }
        }

        /// The one line the drawer shows, for example "Studio Mac is offline".
        public var message: String {
            switch self {
            case .unreachable(let machine): "\(machine.name) is offline"
            case .waitingForApproval(let machine): "\(machine.name) is waiting for approval"
            }
        }
    }

    public static func layout(for machines: [RemiMachineSummary], isAccessibilitySize: Bool) -> Layout {
        switch machines.count {
        case 0: return .none
        case 1: return .header(machines[0])
        default:
            if isAccessibilitySize { return .menu }
            return machines.count <= 4 ? .chips : .scrollingChips
        }
    }

    public static func dotStyle(for reachability: RemiMachineReachability) -> DotStyle {
        switch reachability {
        case .connected: .filled
        case .connecting: .progress
        case .unreachable: .hollow
        case .waitingForApproval: .dashed
        }
    }

    public static func problems(in machines: [RemiMachineSummary]) -> [Problem] {
        machines.compactMap { machine in
            switch machine.reachability {
            case .unreachable: .unreachable(machine)
            case .waitingForApproval: .waitingForApproval(machine)
            case .connected, .connecting: nil
            }
        }
    }

    /// Machines whose sessions are last-known data: the machine is unreachable.
    public static func lastKnownMachineIDs(in machines: [RemiMachineSummary]) -> Set<String> {
        Set(machines.filter { $0.reachability == .unreachable }.map(\.id))
    }

    /// "Studio Mac, connected, 2 waiting".
    public static func accessibilityLabel(for machine: RemiMachineSummary) -> String {
        var label = "\(machine.name), \(dotStyle(for: machine.reachability).accessibilityWord)"
        if machine.openQuestionCount > 0 { label += ", \(machine.openQuestionCount) waiting" }
        return label
    }
}
