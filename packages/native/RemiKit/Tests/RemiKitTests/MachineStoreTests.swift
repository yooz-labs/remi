import Foundation
import Testing
@testable import RemiKit

struct MachineStoreTests {
    @Test func endpointIdentityAndURLAreStable() throws {
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 18765)
        #expect(endpoint.id == "127.0.0.1:18765")
        #expect(endpoint.webSocketURL?.absoluteString == "ws://127.0.0.1:18765/ws")
    }

    @Test @MainActor func storeStartsWithEveryConfiguredMachine() {
        let endpoints = [
            MachineEndpoint(host: "127.0.0.1", port: 18765),
            MachineEndpoint(host: "100.64.0.2", port: 18765),
        ]
        let store = MachineStore(
            endpoints: endpoints,
            identity: ClientIdentity(),
            clientVersion: "test",
            clientId: "test-client"
        )
        #expect(store.machines.map(\.endpoint) == endpoints)
    }

    @Test func machineEndpointsPersistWithoutLeakingUIState() {
        let key = "remi.machine-store-tests.\(UUID().uuidString)"
        let persistence = MachineConfigurationStore(key: key)
        let endpoints = [MachineEndpoint(host: "100.64.0.8", port: 18765)]
        persistence.save(endpoints)
        #expect(persistence.load() == endpoints)
        UserDefaults.standard.removeObject(forKey: key)
    }
}
