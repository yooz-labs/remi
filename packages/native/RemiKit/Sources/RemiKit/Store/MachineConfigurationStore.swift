import Foundation

/// Durable routes for one authenticated machine. `machineID` is only written after
/// the route authenticated the matching machine key; legacy endpoint arrays migrate
/// to one unbound profile per endpoint.
public struct MachineRouteProfile: Codable, Sendable, Equatable, Identifiable {
    public let machineID: String?
    public var routes: [MachineEndpoint]
    public var displayName: String?

    public var id: String { machineID ?? routes.first?.id ?? "empty" }

    public init(machineID: String?, routes: [MachineEndpoint], displayName: String? = nil) {
        self.machineID = machineID
        self.routes = routes
        self.displayName = displayName
    }
}

public struct MachineConfigurationStore: Sendable {
    public static let shared = MachineConfigurationStore(key: "remi.native.machine-endpoints")

    private let key: String

    public init(key: String) {
        self.key = key
    }

    public func load() -> [MachineEndpoint] {
        loadProfiles().flatMap(\.routes)
    }

    public func loadProfiles() -> [MachineRouteProfile] {
        guard let data = UserDefaults.standard.data(forKey: key),
              !data.isEmpty else { return [] }
        if let profiles = try? JSONDecoder().decode([MachineRouteProfile].self, from: data) {
            return profiles.filter { !$0.routes.isEmpty }
        }
        guard let endpoints = try? JSONDecoder().decode([MachineEndpoint].self, from: data) else { return [] }
        let names = loadDisplayNames()
        return endpoints.map { MachineRouteProfile(machineID: nil, routes: [$0], displayName: names[$0.id]) }
    }

    public func save(_ endpoints: [MachineEndpoint]) {
        guard let data = try? JSONEncoder().encode(endpoints) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    public func saveProfiles(_ profiles: [MachineRouteProfile]) {
        guard let data = try? JSONEncoder().encode(profiles.filter { !$0.routes.isEmpty }) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    public func loadDisplayNames() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: displayNamesKey) as? [String: String] ?? [:]
    }

    public func saveDisplayNames(_ names: [String: String]) {
        UserDefaults.standard.set(names, forKey: displayNamesKey)
    }

    private var displayNamesKey: String { "\(key).display-names" }
}
