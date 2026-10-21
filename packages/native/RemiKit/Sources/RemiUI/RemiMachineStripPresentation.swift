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
        public var message: String { message(label: machine.name) }

        /// The same line with a label that tells apart machines sharing a name.
        public func message(label: String) -> String {
            switch self {
            case .unreachable: "\(label) is offline"
            case .waitingForApproval: "\(label) is waiting for approval"
            }
        }
    }

    /// One line in the drawer's problem area.
    public enum ProblemRow: Equatable, Sendable, Identifiable {
        case machine(Problem, label: String)
        /// Three or more problems collapse into this one line.
        case summary(count: Int)

        public var id: String {
            switch self {
            case .machine(let problem, _): problem.id
            case .summary: "summary"
            }
        }

        public var message: String {
            switch self {
            case .machine(let problem, let label): problem.message(label: label)
            case .summary(let count): "\(count) machines need attention"
            }
        }

        public var accessibilityLabel: String { message }
    }

    /// The most problem lines shown one by one; more than this collapse into one summary.
    public static let maximumProblemRows = 2

    /// Up to two lines, one per machine; for three or more problems a single summary line.
    public static func problemRows(in machines: [RemiMachineSummary]) -> [ProblemRow] {
        let all = problems(in: machines)
        guard all.count > maximumProblemRows else {
            let labels = uniqueLabels(for: machines)
            return all.map { .machine($0, label: labels[$0.machine.id] ?? $0.machine.name) }
        }
        return [.summary(count: all.count)]
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

    /// Machine id to the label to show. A name that is unique stays as it is; machines that
    /// share a name each get the address added, "Studio (127.0.0.1:18790)", because the
    /// app has no way to rename a machine.
    public static func uniqueLabels(for machines: [RemiMachineSummary]) -> [String: String] {
        let counts = Dictionary(machines.map { ($0.name, 1) }, uniquingKeysWith: +)
        return Dictionary(machines.map { machine in
            let collides = (counts[machine.name] ?? 0) > 1
            return (machine.id, collides ? "\(machine.name) (\(machine.address))" : machine.name)
        }, uniquingKeysWith: { first, _ in first })
    }

    /// "Studio Mac, connected, 2 waiting". `label` replaces the name when machines share one.
    public static func accessibilityLabel(for machine: RemiMachineSummary, label: String? = nil) -> String {
        var label = "\(label ?? machine.name), \(dotStyle(for: machine.reachability).accessibilityWord)"
        if machine.openQuestionCount > 0 { label += ", \(machine.openQuestionCount) waiting" }
        return label
    }
}
