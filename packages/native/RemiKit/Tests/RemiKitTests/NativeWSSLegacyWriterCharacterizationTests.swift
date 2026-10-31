import Foundation
import Testing
@testable import RemiKit

/// Characterizes the currently shipped reader/writer before proposing any WSS schema.
/// Each test owns a random defaults key and never starts a connection.
@Suite(.serialized)
struct NativeWSSLegacyWriterCharacterizationTests {
    private func profile() throws -> MachineRouteProfile {
        let key = ClientIdentity().publicKeyRaw
        return MachineRouteProfile(
            machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "owned.example", port: 18443)],
            displayName: "Owned", connectionPreference: .localOnly,
            machinePublicKey: RelayCrypto.b64(key), navigationID: "owned.example:18443"
        )
    }

    private func records(_ profile: MachineRouteProfile) throws -> [[String: Any]] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode([profile])) as? [[String: Any]])
    }

    @Test func unknownSecureFieldsAreDroppedByTheActualLegacyWriter() throws {
        let key = "remi.owned-wss-characterization.\(UUID())"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }
        let configuration = MachineConfigurationStore(key: key)
        var input = try records(profile())
        var routes = try #require(input[0]["routes"] as? [[String: Any]])
        routes[0]["transport"] = "wss"
        input[0]["routes"] = routes
        input[0]["secureIntent"] = true
        defaults.set(try JSONSerialization.data(withJSONObject: input), forKey: key)

        let oldProfiles = try configuration.loadProfilesValidated()
        let route = try #require(oldProfiles.first?.routes.first)
        #expect(oldProfiles.first?.connectionPreference == .localOnly)
        #expect(oldProfiles.first?.navigationID == "owned.example:18443")
        #expect(route.webSocketURL?.scheme == "ws")
        configuration.saveProfiles(oldProfiles)

        let rewritten = try #require(defaults.data(forKey: key))
        let output = try #require(JSONSerialization.jsonObject(with: rewritten) as? [[String: Any]])
        let outputRoutes = try #require(output.first?["routes"] as? [[String: Any]])
        #expect(output.first?["secureIntent"] == nil)
        #expect(outputRoutes.first?["transport"] == nil)
    }

    @Test func incompatibleRouteFieldCanBeOverwrittenAfterLegacyLoadFails() throws {
        let key = "remi.owned-wss-characterization.\(UUID())"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }
        let configuration = MachineConfigurationStore(key: key)
        var input = try records(profile())
        var routes = try #require(input[0]["routes"] as? [[String: Any]])
        routes[0]["port"] = "wss:18443"
        input[0]["routes"] = routes
        defaults.set(try JSONSerialization.data(withJSONObject: input), forKey: key)

        #expect(throws: (any Error).self) { try configuration.loadProfilesValidated() }
        #expect(configuration.loadProfiles().isEmpty)
        configuration.saveProfiles(configuration.loadProfiles())
        let rewritten = try #require(defaults.data(forKey: key))
        let output = try #require(JSONSerialization.jsonObject(with: rewritten) as? [[String: Any]])
        #expect(output.isEmpty)
    }

    @Test func alreadyRunningLegacyWriterCanOverwriteAnIncompatibleMigration() throws {
        let key = "remi.owned-wss-characterization.\(UUID())"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }
        let configuration = MachineConfigurationStore(key: key)
        let original = try profile()
        configuration.saveProfiles([original])
        let alreadyLoaded = try configuration.loadProfilesValidated()

        var migrated = try records(original)
        var routes = try #require(migrated[0]["routes"] as? [[String: Any]])
        routes[0]["port"] = "wss:18443"
        migrated[0]["routes"] = routes
        migrated[0]["secureIntent"] = true
        defaults.set(try JSONSerialization.data(withJSONObject: migrated), forKey: key)
        #expect(throws: (any Error).self) { try configuration.loadProfilesValidated() }

        configuration.saveProfiles(alreadyLoaded)
        let recovered = try configuration.loadProfilesValidated()
        #expect(recovered.first?.routes.first?.webSocketURL?.scheme == "ws")
        let data = try #require(defaults.data(forKey: key))
        let rewritten = try #require(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        #expect(rewritten.first?["secureIntent"] == nil)
    }
}
