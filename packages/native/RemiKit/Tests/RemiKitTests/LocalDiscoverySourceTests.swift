import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor DiscoverySourceRecorder {
    var verifiedHub = false
    var receivedSessions = false
    func receive(_ event: RemiInboundEvent, expectedKey: Data) {
        if case .hello(let hello, let key) = event {
            verifiedHub = key == expectedKey && hello.sessionId == nil
                && hello.machine?.id == (try? MachineIdentityVerifier.machineID(forPublicKey: expectedKey))
        }
        if case .sessions = event { receivedSessions = true }
    }
}

struct LocalDiscoverySourceTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_SOURCE_TEST"] == "1",
        "Starts an owned source hub and inert source session; never uses existing owner services."))
    @MainActor func actualSourceHubDiscoveryAuthenticatesSavedFullKey() async throws {
        let identity = ClientIdentity()
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Integration/local-discovery-fixture.ts")
        let fixture = Process(), input = Pipe(), output = Pipe()
        fixture.executableURL = URL(fileURLWithPath: "/Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64")
        fixture.arguments = [script.path]
        fixture.environment = ["PATH": "/private/tmp/remi-1570-tools:/usr/bin:/bin"]
        fixture.standardInput = input; fixture.standardOutput = output; fixture.standardError = FileHandle.standardError
        try fixture.run()
        defer {
            try? input.fileHandleForWriting.close()
            if fixture.isRunning { fixture.terminate() }
            fixture.waitUntilExit()
        }
        let client = try JSONSerialization.data(withJSONObject: ["publicKey": identity.publicKeyBase64])
        try input.fileHandleForWriting.write(contentsOf: client + Data([10]))
        var line = Data()
        for try await byte in output.fileHandleForReading.bytes {
            if byte == 10 { break }; line.append(byte)
        }
        let metadata = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        let encodedKey = try #require(metadata["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encodedKey))
        let hubPort = try #require(metadata["hubPort"] as? Int)
        let childPort = try #require(metadata["sessionPort"] as? Int)
        #expect(metadata["collisions"] as? Int == 0)
        let sourceTargets = try #require(metadata["observedTargets"] as? [String])
        #expect(!sourceTargets.isEmpty && sourceTargets.allSatisfy { $0.hasSuffix(".local") },
            Comment(rawValue: "Owned SRV targets: \(sourceTargets)"))
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "192.0.2.1", port: hubPort)],
            connectionPreference: .localOnly, machinePublicKey: RelayCrypto.b64(key))
        let target = try #require(LocalDiscoveryTarget(profile: saved, lifetime: UUID(), policyRevision: 1))
        let discovery = LocalMachineDiscovery()
        var candidates: [LocalDiscoveryCandidate] = []
        var finished: LocalDiscoveryOutcome?
        discovery.start(targets: [target]) {
            if case .candidates(let value) = $0 { candidates = value }
            if case .finished(let value) = $0 { finished = value }
        }
        defer { discovery.cancel() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(7))
        while candidates.isEmpty, finished == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(candidates.allSatisfy { $0.port == hubPort && $0.port != childPort })
        #expect(!candidates.isEmpty, Comment(rawValue: "Owned tuples: \(discovery.ownedDiscoveryObservation); retained=\(discovery.retainedServiceCount), outcome=\(String(describing: finished))"))
        let endpoint = try #require(candidates.first?.endpoint)
        let recorder = DiscoverySourceRecorder()
        let connection = RemiConnection(configuration: .init(url: try #require(endpoint.webSocketURL),
            clientVersion: "owned-discovery", clientId: "owned-discovery", expectedServerFingerprint: target.fingerprint,
            expectedServerPublicKey: key.base64EncodedString(), expectedMachineID: target.machineID), identity: identity,
            stateHandler: { _ in }, eventHandler: { event in Task { await recorder.receive(event, expectedKey: key) } })
        await connection.start()
        let authDeadline = ContinuousClock.now.advanced(by: .seconds(8))
        while !(await recorder.verifiedHub), ContinuousClock.now < authDeadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(await recorder.verifiedHub)
        if await recorder.verifiedHub {
            try await connection.send(SessionListRequestMessage(id: UUID().uuidString, timestamp: Date().ISO8601Format(), includeExternal: false))
            let listDeadline = ContinuousClock.now.advanced(by: .seconds(3))
            while !(await recorder.receivedSessions), ContinuousClock.now < listDeadline {
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(await recorder.receivedSessions)
        }
        await connection.stop()
    }
}
#endif
