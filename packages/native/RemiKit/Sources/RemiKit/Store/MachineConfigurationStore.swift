import Foundation

/// Durable routes for one authenticated machine. `machineID` is only written after
/// the route authenticated the matching machine key; legacy endpoint arrays migrate
/// to one unbound profile per endpoint.
public struct MachineRouteProfile: Codable, Sendable, Equatable, Identifiable {
    public let machineID: String?
    public var routes: [MachineEndpoint]
    public var displayName: String?
    public var connectionPreference: MachineConnectionPreference
    /// Public pin captured from an authenticated Hello, never a device secret.
    public var machinePublicKey: String?

    public var id: String { machineID ?? routes.first?.id ?? "empty" }

    public init(machineID: String?, routes: [MachineEndpoint], displayName: String? = nil,
                connectionPreference: MachineConnectionPreference = .automatic,
                machinePublicKey: String? = nil) {
        self.machineID = machineID
        self.routes = routes
        self.displayName = displayName
        self.connectionPreference = connectionPreference
        self.machinePublicKey = machinePublicKey
    }

    private enum CodingKeys: String, CodingKey { case machineID, routes, displayName, connectionPreference, machinePublicKey }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        machineID = try values.decodeIfPresent(String.self, forKey: .machineID)
        routes = try values.decode([MachineEndpoint].self, forKey: .routes)
        displayName = try values.decodeIfPresent(String.self, forKey: .displayName)
        connectionPreference = try values.decodeIfPresent(MachineConnectionPreference.self,
            forKey: .connectionPreference) ?? .automatic
        machinePublicKey = try values.decodeIfPresent(String.self, forKey: .machinePublicKey)
    }

    /// A missing full pin is a legacy profile. A present but invalid pin is
    /// corrupt trust, never permission to connect without the saved pin (#1571).
    func verifiedSavedIdentity() throws -> (key: Data, machineID: String)? {
        let relayKeys = routes.compactMap(\.relayPin).map(\.machinePublicKey)
        guard let encoded = machinePublicKey ?? relayKeys.first else { return nil }
        guard let key = try? RelayCrypto.unb64(encoded), key.count == 32,
              let derived = try? MachineIdentityVerifier.machineID(forPublicKey: key),
              machineID == nil || machineID == derived,
              relayKeys.allSatisfy({ (try? RelayCrypto.unb64($0)) == key }),
              routes.allSatisfy({ $0.expectedPublicKey == nil || $0.expectedPublicKey == key.base64EncodedString() }) else {
            throw MachineConfigurationStore.ReadError.invalidSavedConfiguration
        }
        return (key, derived)
    }
}

public struct MachineConfigurationStore: Sendable {
    public enum ReadError: Error { case invalidSavedConfiguration }
    public static let shared = MachineConfigurationStore(key: "remi.native.machine-endpoints")

    private let key: String

    public init(key: String) {
        self.key = key
    }

    public func load() -> [MachineEndpoint] {
        loadProfiles().flatMap(\.routes)
    }

    public func loadProfiles() -> [MachineRouteProfile] {
        (try? loadProfilesValidated()) ?? []
    }

    /// Cold actions cannot reinterpret a corrupt layer lock as Automatic.
    public func loadProfilesValidated() throws -> [MachineRouteProfile] {
        guard let data = UserDefaults.standard.data(forKey: key),
              !data.isEmpty else {
            if UserDefaults.standard.object(forKey: key) != nil { throw ReadError.invalidSavedConfiguration }
            return []
        }
        let records = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        if records?.contains(where: { $0["routes"] != nil || $0["connectionPreference"] != nil || $0["machinePublicKey"] != nil }) == true {
            guard let profiles = try? JSONDecoder().decode([MachineRouteProfile].self, from: data) else {
                throw ReadError.invalidSavedConfiguration
            }
            for profile in profiles { _ = try profile.verifiedSavedIdentity() }
            return profiles.filter { !$0.routes.isEmpty }
        }
        guard let endpoints = try? JSONDecoder().decode([MachineEndpoint].self, from: data) else {
            throw ReadError.invalidSavedConfiguration
        }
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
