import RemiKit

public enum RemiNeedsYouAvailability: Equatable, Sendable {
    case unconfigured
    case offline(total: Int)
    case partiallyConnected(connected: Int, total: Int)
    case connected(total: Int)

    public static func resolve(machines: [MachineState]) -> Self {
        guard !machines.isEmpty else { return .unconfigured }
        let connected = machines.filter { $0.status == .connected }.count
        if connected == 0 { return .offline(total: machines.count) }
        if connected == machines.count { return .connected(total: machines.count) }
        return .partiallyConnected(connected: connected, total: machines.count)
    }
}
