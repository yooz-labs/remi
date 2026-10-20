import Foundation

public enum RemiHomeLifecycleState: Equatable, Sendable {
    case content
    case firstRun
    case noSearchResults
    case noSessionsAllMachines
    case noSessionsForMachine

    public static func resolve(
        machineCount: Int,
        visibleSessionCount: Int,
        query: String,
        hasSelectedMachine: Bool
    ) -> Self {
        if machineCount == 0 { return .firstRun }
        if visibleSessionCount > 0 { return .content }
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .noSearchResults
        }
        return hasSelectedMachine ? .noSessionsForMachine : .noSessionsAllMachines
    }
}
