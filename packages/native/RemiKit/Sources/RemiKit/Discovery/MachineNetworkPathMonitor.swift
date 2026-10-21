import Foundation
import Network

/// Only a recovery trigger. A satisfied path proves neither a hub nor a VPN is
/// reachable, so consumers must still authenticate each candidate endpoint.
struct MachineNetworkPath: Sendable, Equatable {
    let satisfied: Bool
    let interfaces: [String]
    let expensive: Bool
    let constrained: Bool

    init(_ path: NWPath) {
        satisfied = path.status == .satisfied
        interfaces = path.availableInterfaces.map { "\($0.type):\($0.name)" }.sorted()
        expensive = path.isExpensive
        constrained = path.isConstrained
    }
}

@MainActor
final class MachineNetworkPathMonitor {
    private var monitor: NWPathMonitor?
    private var epoch = UUID()

    var isMonitoring: Bool { monitor != nil }

    func start(onChange: @escaping @MainActor (MachineNetworkPath) -> Void) {
        stop()
        let run = epoch
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let snapshot = MachineNetworkPath(path)
            Task { @MainActor in
                // The same interface names can survive a Wi-Fi network/address
                // change. Preserve the monitor's trigger even when these few
                // descriptive fields compare equal; recovery owns debouncing.
                guard let self, self.epoch == run, self.monitor != nil else { return }
                onChange(snapshot)
            }
        }
        monitor.start(queue: .main)
    }

    func stop() {
        epoch = UUID()
        monitor?.cancel(); monitor = nil
    }
}
