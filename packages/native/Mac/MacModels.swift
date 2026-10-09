import RemiUI

struct MacMachine: Identifiable, Hashable {
    let id: String
    let name: String
    let address: String
    let repositories: [String]
    let reachability: RemiMachineReachability
}

enum MacPreviewData {
    static let machines = [
        MacMachine(id: "studio", name: "Studio", address: "127.0.0.1:18765", repositories: ["remi", "transit"], reachability: .connected),
        MacMachine(id: "laptop", name: "Laptop", address: "100.72.14.8:18765", repositories: ["whisper"], reachability: .waitingForApproval),
    ]

    static let unreachableMachines = [
        MacMachine(id: "studio", name: "Studio", address: "127.0.0.1:18765", repositories: ["remi", "transit"], reachability: .unreachable),
        machines[1],
    ]
}
