import Darwin
import Foundation
import Testing
@testable import RemiKit

@Suite(.serialized)
@MainActor
struct LocalMachineDiscoveryTests {
    private func profile(_ preference: MachineConnectionPreference = .automatic) throws -> MachineRouteProfile {
        let key = ClientIdentity().publicKeyRaw
        return MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "192.168.1.2", port: 18765)],
            connectionPreference: preference, machinePublicKey: RelayCrypto.b64(key))
    }

    @Test func onlyValidatedSavedLocalAuthorityCanStartDiscovery() throws {
        for preference in MachineConnectionPreference.allCases {
            let saved = try profile(preference)
            let target = LocalDiscoveryTarget(profile: saved, lifetime: UUID(), policyRevision: 8)
            #expect((target != nil) == (preference == .automatic || preference == .localOnly))
            if let target {
                #expect(target.machineID == saved.machineID)
                #expect(target.fingerprint == ClientIdentity.fingerprint(ofPublicKeyRaw: target.publicKey))
                #expect(target.policyRevision == 8)
            }
        }
        var legacy = try profile()
        legacy.machinePublicKey = nil
        #expect(LocalDiscoveryTarget(profile: legacy, lifetime: UUID(), policyRevision: 0) == nil)
        var corrupt = try profile()
        corrupt.machinePublicKey = "invalid"
        #expect(LocalDiscoveryTarget(profile: corrupt, lifetime: UUID(), policyRevision: 0) == nil)
        let wrongID = MachineRouteProfile(machineID: String(repeating: "0", count: 32), routes: legacy.routes,
            machinePublicKey: try profile().machinePublicKey)
        #expect(LocalDiscoveryTarget(profile: wrongID, lifetime: UUID(), policyRevision: 0) == nil)
    }

    @Test func strictLocksAndUnpinnedProfilesCreateNoBrowserOrResolver() throws {
        let discovery = LocalMachineDiscovery()
        var outcomes: [LocalDiscoveryOutcome] = []
        let targets = try [.tailscaleOnly, .relayOnly].compactMap {
            LocalDiscoveryTarget(profile: try profile($0), lifetime: UUID(), policyRevision: 0)
        }
        discovery.start(targets: targets) { if case .finished(let outcome) = $0 { outcomes.append(outcome) } }
        #expect(outcomes == [.noEligibleProfiles])
        #expect(!discovery.isBrowsing)
        #expect(discovery.retainedServiceCount == 0)
        #expect(discovery.activeResolverCount == 0)
    }

    @Test(arguments: ["0123456789abcdef", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "0123456789abcdeg"])
    func fingerprintIsCanonicalShortlistOnly(_ value: String) {
        #expect(LocalMachineDiscovery.isCanonicalFingerprint(value) == (value == "0123456789abcdef"))
    }

    @Test func actualSockaddrBytesEnforceFamilyLengthPortAndUnicast() throws {
        for host in ["192.168.1.2", "10.1.2.3", "100.64.1.2", "2001:db8::5", "fd00::2"] {
            #expect(LocalDiscoveryAddress.numericHost(try address(host), port: 18765) == host)
        }
        for host in ["0.0.0.0", "0.1.2.3", "127.0.0.1", "169.254.4.2", "224.0.0.1", "255.255.255.255",
                     "::", "::1", "fe80::2", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.4.2"] {
            #expect(LocalDiscoveryAddress.numericHost(try address(host), port: 18765) == nil)
        }
        #expect(LocalDiscoveryAddress.numericHost(try address("::ffff:192.168.1.2"), port: 18765) == "192.168.1.2")
        let valid = try address("192.168.1.2")
        #expect(LocalDiscoveryAddress.numericHost(valid, port: 18766) == nil)
        #expect(LocalDiscoveryAddress.numericHost(valid, port: 0) == nil)
        #expect(LocalDiscoveryAddress.numericHost(valid.dropLast(), port: 18765) == nil)
        #expect(LocalDiscoveryAddress.numericHost(valid + Data([0]), port: 18765) == nil)
        var malformed = valid
        malformed[0] = 0
        #expect(LocalDiscoveryAddress.numericHost(malformed, port: 18765) == nil)
        malformed = valid; malformed[1] = UInt8(AF_UNIX)
        #expect(LocalDiscoveryAddress.numericHost(malformed, port: 18765) == nil)
        #expect(LocalDiscoveryAddress.numericHost(Data(), port: 18765) == nil)
    }

    private func address(_ host: String, port: UInt16 = 18765) throws -> Data {
        if host.contains(":") {
            var address = sockaddr_in6()
            address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
            address.sin6_family = sa_family_t(AF_INET6)
            address.sin6_port = port.bigEndian
            #expect(inet_pton(AF_INET6, host, &address.sin6_addr) == 1)
            return withUnsafeBytes(of: address) { Data($0) }
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        #expect(inet_pton(AF_INET, host, &address.sin_addr) == 1)
        return withUnsafeBytes(of: address) { Data($0) }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_TEST"] == "1",
        "Opt in to owned Bonjour publication and real browsing; never accepts OS permission prompts."))
    func realBonjourFiltersHubMetadataResolvesAndCancels() async throws {
        let saved = try profile()
        let target = try #require(LocalDiscoveryTarget(profile: saved, lifetime: UUID(), policyRevision: 1))
        var publishers: [NetService] = []
        defer { publishers.forEach { $0.stop(); $0.remove(from: .main, forMode: .common) } }
        let suffix = UUID().uuidString.prefix(8)
        for (name, role, auth, fingerprint) in [
            ("hub", "hub", "true", target.fingerprint),
            ("child", "session", "true", target.fingerprint),
            ("unauthed", "hub", "false", target.fingerprint),
            ("other-key", "hub", "true", String(repeating: "0", count: 16)),
            ("old", "", "true", target.fingerprint),
        ] {
            let publisher = NetService(domain: "local.", type: "_remi._tcp.", name: "remi-1575-\(suffix)-\(name)", port: 24751)
            #expect(publisher.setTXTRecord(NetService.data(fromTXTRecord: ["auth": Data(auth.utf8),
                "role": Data(role.utf8), "fingerprint": Data(fingerprint.utf8)])))
            publisher.schedule(in: .main, forMode: .common)
            publisher.publish()
            publishers.append(publisher)
        }
        let discovery = LocalMachineDiscovery()
        var candidates: [LocalDiscoveryCandidate] = []
        var outcomes: [LocalDiscoveryOutcome] = []
        discovery.start(targets: [target]) {
            switch $0 {
            case .candidates(let next): candidates = next
            case .finished(let outcome): outcomes.append(outcome)
            }
        }
        defer { discovery.cancel() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(7))
        while candidates.isEmpty, outcomes.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(outcomes.isEmpty, "Permission denial or browse failure requires owner review, never automatic permission acceptance")
        #expect(!candidates.isEmpty)
        #expect(candidates.allSatisfy { $0.service.name == "remi-1575-\(suffix)-hub" && $0.port == 24751 })
        #expect(candidates.count <= LocalDiscoveryLimits.candidatesPerProfile)
        #expect(discovery.retainedServiceCount == 1)
        #expect(discovery.activeResolverCount <= 2)
        #expect(candidates.allSatisfy { $0.endpoint.expectedPublicKey == target.publicKey.base64EncodedString() })
        publishers[0].stop()
        let removedDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !candidates.isEmpty, ContinuousClock.now < removedDeadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(candidates.isEmpty)
        let replacement = NetService(domain: "local.", type: "_remi._tcp.",
            name: "remi-1575-\(suffix)-hub", port: 24752)
        #expect(replacement.setTXTRecord(NetService.data(fromTXTRecord: ["auth": Data("true".utf8),
            "role": Data("hub".utf8), "fingerprint": Data(target.fingerprint.utf8)])))
        replacement.schedule(in: .main, forMode: .common); replacement.publish()
        publishers.append(replacement)
        let reappearedDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !candidates.contains(where: { $0.port == 24752 }), outcomes.isEmpty, ContinuousClock.now < reappearedDeadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(candidates.contains { $0.port == 24752 })
        #expect(candidates.allSatisfy { $0.port != 24751 })
        discovery.cancel()
        let count = candidates.count
        try await Task.sleep(for: .milliseconds(150))
        #expect(outcomes == [.cancelled])
        #expect(!discovery.isBrowsing && discovery.activeResolverCount == 0 && discovery.retainedServiceCount == 0)
        #expect(candidates.count == count)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_TEST"] == "1",
        "Opt in to owned Bonjour publication and real browsing."))
    func realBonjourRetainsBoundedServicesAndCandidates() async throws {
        let target = try #require(LocalDiscoveryTarget(profile: try profile(), lifetime: UUID(), policyRevision: 1))
        let suffix = UUID().uuidString.prefix(8)
        let publishers = (0..<40).map { index in
            let publisher = NetService(domain: "local.", type: "_remi._tcp.",
                name: "remi-1575-\(suffix)-\(index)", port: Int32(24800 + index))
            _ = publisher.setTXTRecord(NetService.data(fromTXTRecord: ["auth": Data("true".utf8),
                "role": Data("hub".utf8), "fingerprint": Data(target.fingerprint.utf8)]))
            publisher.schedule(in: .main, forMode: .common); publisher.publish()
            return publisher
        }
        defer { publishers.forEach { $0.stop(); $0.remove(from: .main, forMode: .common) } }
        let discovery = LocalMachineDiscovery()
        var candidates: [LocalDiscoveryCandidate] = []
        var maxCandidates = 0
        discovery.start(targets: [target]) {
            if case .candidates(let next) = $0 { candidates = next; maxCandidates = max(maxCandidates, next.count) }
        }
        defer { discovery.cancel() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(6))
        while (discovery.retainedServiceCount < 32 || candidates.count < 4), ContinuousClock.now < deadline {
            #expect(discovery.activeResolverCount <= 2)
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(discovery.retainedServiceCount == 32)
        #expect(candidates.count == 4 && maxCandidates == 4)
        #expect(Set(candidates.map(\.id)).count == candidates.count)
    }

    @Test func realPathMonitorStopsAndDropsQueuedCallbacks() async throws {
        let monitor = MachineNetworkPathMonitor()
        var changes = 0
        monitor.start { _ in changes += 1 }
        #expect(monitor.isMonitoring)
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while changes == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(changes == 1)
        monitor.stop()
        let stoppedAt = changes
        try await Task.sleep(for: .milliseconds(100))
        #expect(!monitor.isMonitoring && changes == stoppedAt)
        // A newly started monitor has a new epoch; stopping it before delivery
        // cannot let either monitor's callback escape into the next lifecycle.
        monitor.start { _ in changes += 1 }; monitor.stop()
        try await Task.sleep(for: .milliseconds(100))
        #expect(changes == stoppedAt)
    }
}
