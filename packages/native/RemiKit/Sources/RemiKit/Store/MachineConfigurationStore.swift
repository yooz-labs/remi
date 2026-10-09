import Foundation

public struct MachineConfigurationStore: Sendable {
    public static let shared = MachineConfigurationStore(key: "remi.native.machine-endpoints")

    private let key: String

    public init(key: String) {
        self.key = key
    }

    public func load() -> [MachineEndpoint] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let endpoints = try? JSONDecoder().decode([MachineEndpoint].self, from: data)
        else { return [] }
        return endpoints
    }

    public func save(_ endpoints: [MachineEndpoint]) {
        guard let data = try? JSONEncoder().encode(endpoints) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}
