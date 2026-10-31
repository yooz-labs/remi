import Foundation

/// Durable routes for one authenticated machine. `machineID` is only written after
/// the route authenticated the matching machine key; legacy endpoint arrays migrate
/// to one unbound profile per endpoint.
public struct MachineRouteProfile: Codable, Sendable, Equatable, Identifiable {
    public let machineID: String?
    public var routes: [MachineEndpoint]
    public var displayName: String?
    public var connectionPreference: MachineConnectionPreference
    /// Local navigation identity survives adding a route that sorts before the original.
    public var navigationID: String?
    /// Public pin captured from an authenticated Hello, never a device secret.
    public var machinePublicKey: String?

    public var id: String { machineID ?? routes.first?.id ?? "empty" }

    public init(machineID: String?, routes: [MachineEndpoint], displayName: String? = nil,
                connectionPreference: MachineConnectionPreference = .automatic,
                machinePublicKey: String? = nil, navigationID: String? = nil) {
        self.machineID = machineID
        self.routes = routes
        self.displayName = displayName
        self.connectionPreference = connectionPreference
        self.machinePublicKey = machinePublicKey
        self.navigationID = navigationID
    }

    private enum CodingKeys: String, CodingKey { case machineID, routes, displayName, connectionPreference, machinePublicKey, navigationID }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        machineID = try values.decodeIfPresent(String.self, forKey: .machineID)
        routes = try values.decode([MachineEndpoint].self, forKey: .routes)
        displayName = try values.decodeIfPresent(String.self, forKey: .displayName)
        connectionPreference = try values.decodeIfPresent(MachineConnectionPreference.self,
            forKey: .connectionPreference) ?? .automatic
        machinePublicKey = try values.decodeIfPresent(String.self, forKey: .machinePublicKey)
        navigationID = try values.decodeIfPresent(String.self, forKey: .navigationID)
    }

    /// A missing full pin is a legacy profile. A present but invalid pin is
    /// corrupt trust, never permission to connect without the saved pin (#1571).
    func verifiedSavedIdentity() throws -> (key: Data, machineID: String)? {
        guard navigationID == nil || routes.contains(where: { $0.id == navigationID }) else {
            throw MachineConfigurationStore.ReadError.invalidSavedConfiguration
        }
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

    /// A local-forget plan is memory-only and must be prepared before the profile is removed.
    /// It does not associate a historical notification owner with a saved profile.
    @MainActor func prepareLocalForgetProfiles(_ profiles: [MachineRouteProfile]) throws -> LocalNoticeProfileWritePlan {
        guard let domain = Bundle.main.bundleIdentifier, !domain.isEmpty else { throw LocalNoticeProfilePersistenceError.unavailable }
        return try prepareLocalForgetProfiles(profiles, defaults: .standard, domainName: domain)
    }

    @MainActor func prepareLocalForgetProfiles(_ profiles: [MachineRouteProfile], defaults: UserDefaults,
                                              domainName: String,
                                              expectedCurrent: [MachineRouteProfile]? = nil,
                                              encode: ([MachineRouteProfile]) throws -> Data = { try JSONEncoder().encode($0) }) throws -> LocalNoticeProfileWritePlan {
        let existing = defaults.persistentDomain(forName: domainName)?[key]
        let original: Data?
        if let existing {
            guard let data = existing as? Data, !data.isEmpty else { throw LocalNoticeProfilePersistenceError.corruptExisting }
            let records = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
            let saved: [MachineRouteProfile]
            if records?.contains(where: { $0["routes"] != nil || $0["connectionPreference"] != nil || $0["machinePublicKey"] != nil }) == true {
                guard let decoded = try? JSONDecoder().decode([MachineRouteProfile].self, from: data) else { throw LocalNoticeProfilePersistenceError.corruptExisting }
                do { for profile in decoded { _ = try profile.verifiedSavedIdentity() } }
                catch { throw LocalNoticeProfilePersistenceError.corruptExisting }
                saved = decoded.filter { !$0.routes.isEmpty }
            } else {
                guard let endpoints = try? JSONDecoder().decode([MachineEndpoint].self, from: data) else { throw LocalNoticeProfilePersistenceError.corruptExisting }
                let names = defaults.persistentDomain(forName: domainName)?[displayNamesKey] as? [String: String] ?? [:]
                saved = endpoints.map { MachineRouteProfile(machineID: nil, routes: [$0], displayName: names[$0.id]) }
            }
            if let expectedCurrent, !Self.savedProfiles(saved, areRepresentedBy: expectedCurrent) {
                throw LocalNoticeProfilePersistenceError.changed
            }
            original = data
        } else { original = nil }
        let intendedProfiles = profiles.filter { !$0.routes.isEmpty }
        do { for profile in intendedProfiles { _ = try profile.verifiedSavedIdentity() } }
        catch { throw LocalNoticeProfilePersistenceError.encodingFailed }
        // A runtime-only direct pin must have the enclosing durable profile pin, or this
        // write would silently discard trust when Endpoint's Codable projection omits it.
        for profile in intendedProfiles {
            for route in profile.routes {
                if let runtimePin = route.expectedPublicKey {
                    guard let encoded = profile.machinePublicKey, let durable = try? RelayCrypto.unb64(encoded),
                          Data(base64Encoded: runtimePin) == durable else { throw LocalNoticeProfilePersistenceError.encodingFailed }
                }
            }
        }
        guard let persistedProjection = Self.persistedProjection(intendedProfiles) else {
            throw LocalNoticeProfilePersistenceError.encodingFailed
        }
        let intended: Data
        do { intended = try encode(intendedProfiles) } catch { throw LocalNoticeProfilePersistenceError.encodingFailed }
        guard (try? JSONDecoder().decode([MachineRouteProfile].self, from: intended)) == persistedProjection else {
            throw LocalNoticeProfilePersistenceError.encodingFailed
        }
        return LocalNoticeProfileWritePlan(key: key, domainName: domainName, original: original, intended: intended)
    }

    @MainActor func commitLocalForgetProfiles(_ plan: LocalNoticeProfileWritePlan) throws {
        try commitLocalForgetProfiles(plan, defaults: .standard, flush: { $0.synchronize() })
    }

    @MainActor func localForgetPlan(_ plan: LocalNoticeProfileWritePlan, matches profiles: [MachineRouteProfile]) -> Bool {
        guard plan.key == key, let intended = try? JSONDecoder().decode([MachineRouteProfile].self, from: plan.intended) else { return false }
        return intended == Self.persistedProjection(profiles.filter { !$0.routes.isEmpty })
    }

    /// Endpoint Codable deliberately omits runtime-only pairing data and direct full keys;
    /// the enclosing profile persists the pin. Compare the project's real Codable projection.
    private static func persistedProjection(_ profiles: [MachineRouteProfile]) -> [MachineRouteProfile]? {
        guard let data = try? JSONEncoder().encode(profiles) else { return nil }
        return try? JSONDecoder().decode([MachineRouteProfile].self, from: data)
    }

    /// Refuse to overwrite saved routes or explicit settings missing from the current Store.
    /// Current Store additions and authenticated pin upgrades are allowed, but each saved route
    /// must map to exactly one current profile with its explicit persisted values preserved.
    private static func savedProfiles(_ saved: [MachineRouteProfile], areRepresentedBy current: [MachineRouteProfile]) -> Bool {
        for profile in saved {
            for route in profile.routes {
                let owners = current.filter { $0.routes.contains(where: { $0.id == route.id }) }
                guard owners.count == 1, let owner = owners.first,
                      owner.connectionPreference == profile.connectionPreference,
                      owner.displayName == profile.displayName,
                      profile.machineID == nil || profile.machineID == owner.machineID,
                      profile.navigationID == nil || profile.navigationID == owner.navigationID,
                      profile.machinePublicKey == nil || profile.machinePublicKey == owner.machinePublicKey,
                      let savedRoute = owner.routes.first(where: { $0.id == route.id }),
                      route.expectedFingerprint == nil || route.expectedFingerprint == savedRoute.expectedFingerprint,
                      route.expectedPublicKey == nil || route.expectedPublicKey == savedRoute.expectedPublicKey,
                      route.relayPin == savedRoute.relayPin else { return false }
            }
        }
        return true
    }

    /// The pending journal intent must remain until this succeeds. MainActor serialization
    /// covers current iPhone writers; UserDefaults does not provide cross-process CAS, fsync
    /// or an atomic transaction with SQLite.
    @MainActor func commitLocalForgetProfiles(_ plan: LocalNoticeProfileWritePlan, defaults: UserDefaults,
                                             flush: (UserDefaults) -> Bool) throws {
        guard plan.key == key else { throw LocalNoticeProfilePersistenceError.changed }
        let current = defaults.persistentDomain(forName: plan.domainName)?[key]
        guard current == nil || current is Data else { throw LocalNoticeProfilePersistenceError.changed }
        let bytes = current as? Data
        guard bytes == plan.original || bytes == plan.intended else { throw LocalNoticeProfilePersistenceError.changed }
        defaults.set(plan.intended, forKey: key)
        guard flush(defaults) else { throw LocalNoticeProfilePersistenceError.unavailable }
        guard let persisted = defaults.persistentDomain(forName: plan.domainName)?[key] as? Data,
              persisted == plan.intended else { throw LocalNoticeProfilePersistenceError.readbackMismatch }
    }

    public func loadDisplayNames() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: displayNamesKey) as? [String: String] ?? [:]
    }

    public func saveDisplayNames(_ names: [String: String]) {
        UserDefaults.standard.set(names, forKey: displayNamesKey)
    }

    private var displayNamesKey: String { "\(key).display-names" }
}

/// Contains local profile bytes only in memory; never persist or log this retry plan.
struct LocalNoticeProfileWritePlan {
    fileprivate let key: String
    fileprivate let domainName: String
    fileprivate let original: Data?
    fileprivate let intended: Data
}

enum LocalNoticeProfilePersistenceError: Error, Equatable {
    case corruptExisting, encodingFailed, unavailable, readbackMismatch, changed
}
