import Foundation
import Testing
@testable import RemiKit

struct MachineIdentityTests {
    private let machineKey = Data(hex: "142f1ad73abf6f791e098a0785db639e3a7ec4dbd64b2cdea8059bfa701dc914")
    private let impostorKey = Data(hex: "d6b14af4bb7b4986a0621f605db5551287780b2d18581f8cb60b20807a13e7f2")

    @Test func roomIDMatchesRelayOracleForDirectAuthority() throws {
        #expect(try MachineIdentityVerifier.machineID(forPublicKey: machineKey)
            == "397e2eedccc2603b7f5e9cf484fd763e")
        #expect(try MachineIdentityVerifier.machineID(
            forDirectServerPublicKey: machineKey.base64EncodedString())
            == "397e2eedccc2603b7f5e9cf484fd763e")
    }

    @Test func directAuthorityAcceptsMatchingDescriptorAndRejectsMismatch() throws {
        let descriptor = MachineDescriptor(
            id: "397e2eedccc2603b7f5e9cf484fd763e",
            name: "Vector machine",
            platform: "darwin",
            remiVersion: "0.7.4",
            harnesses: ["claude"],
            capabilities: [])
        #expect(throws: Never.self) {
            try MachineIdentityVerifier.verify(descriptor: descriptor, authorityPublicKey: machineKey)
        }
        let mismatch = MachineDescriptor(
            id: "9b250c8edfdc5735d609c71b1cd6e4d7",
            name: descriptor.name,
            platform: descriptor.platform,
            remiVersion: descriptor.remiVersion,
            harnesses: descriptor.harnesses,
            capabilities: descriptor.capabilities)
        #expect(throws: MachineIdentityVerificationError.descriptorMismatch) {
            try MachineIdentityVerifier.verify(descriptor: mismatch, authorityPublicKey: machineKey)
        }
    }

    @Test func relayPinAuthorityUsesTheSameRoomIDAndRejectsForeignSessionIdentity() throws {
        let pin = try RelayMachinePin(
            relayURL: "wss://relay.example.test",
            machinePublicKey: RelayCrypto.b64(machineKey))
        #expect(try MachineIdentityVerifier.machineID(forRelayPin: pin)
            == "397e2eedccc2603b7f5e9cf484fd763e")
        let descriptor = MachineDescriptor(
            id: "397e2eedccc2603b7f5e9cf484fd763e",
            name: "Vector machine",
            platform: "darwin",
            remiVersion: "0.7.4",
            harnesses: ["claude"],
            capabilities: [])
        let foreign = DiscoverableSession(
            sessionId: "session",
            name: nil,
            projectPath: "/tmp/project",
            status: "active",
            lastActivity: nil,
            source: "daemon",
            lastMessage: nil,
            harness: nil,
            canAttach: nil,
            wsPort: nil,
            claudeSessionId: nil,
            transcriptPath: nil,
            canResume: nil,
            machineId: "9b250c8edfdc5735d609c71b1cd6e4d7")
        #expect(throws: MachineIdentityVerificationError.sessionMismatch) {
            try MachineIdentityVerifier.verify(
                descriptor: descriptor, sessions: [foreign], authorityPublicKey: machineKey)
        }
        #expect(throws: MachineIdentityVerificationError.descriptorMismatch) {
            try MachineIdentityVerifier.verify(
                descriptor: descriptor, authorityPublicKey: impostorKey)
        }
    }

    @Test func legacyPeerCanOmitDescriptorAndIdentity() throws {
        #expect(throws: Never.self) {
            try MachineIdentityVerifier.verify(descriptor: nil, authorityPublicKey: nil)
        }
    }

    @Test func descriptorRequiresBoundedDisplayName() throws {
        let invalid = MachineDescriptor(
            id: "397e2eedccc2603b7f5e9cf484fd763e",
            name: String(repeating: "x", count: 65),
            platform: "darwin",
            remiVersion: "0.7.4",
            harnesses: [],
            capabilities: [])
        #expect(throws: MachineIdentityVerificationError.descriptorMismatch) {
            try MachineIdentityVerifier.verify(descriptor: invalid, authorityPublicKey: machineKey)
        }
    }
}

private extension Data {
    init(hex: String) {
        let bytes = Array(hex.utf8)
        precondition(bytes.count.isMultiple(of: 2))
        self.init(stride(from: 0, to: bytes.count, by: 2).map { index in
            guard let byte = UInt8(String(decoding: bytes[index...index + 1], as: UTF8.self), radix: 16)
            else { preconditionFailure("Invalid test hex") }
            return byte
        })
    }
}
