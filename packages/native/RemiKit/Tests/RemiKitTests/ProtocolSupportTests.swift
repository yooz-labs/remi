import Foundation
import Testing
@testable import RemiKit

/// The capability gate against the real `hello_ack*` golden fixtures, and the cases of
/// `packages/shared/tests/protocol-version.test.ts`.
struct ProtocolSupportTests {
    static func ack(_ fixture: String) throws -> HubSupportAck {
        HubSupportAck(json: try WireJSON.parse(FixtureConformanceTests.fixture(fixture)))
    }

    private static let updateMachine = "Update remi on that machine and restart it."

    @Test func versionIsOne() {
        #expect(ProtocolVersion.current == 1)
    }

    @Test func capabilityNamesMatchTheWire() {
        #expect(
            HubCapability.allCases.map(\.rawValue)
                == [
                    "workspaces", "image_staging", "image_insertion", "structured_chat", "browser_links",
                    "file_download", "terminal_view",
                ])
        #expect(HubCapability.terminalView.isAdvertisedByDaemons == false)
        #expect(HubCapability.allCases.filter(\.isAdvertisedByDaemons).count == 6)
    }

    @Test func capabilityTextMatchesTheSharedRegistry() throws {
        // The registry text lives in protocol-version.ts; read the source so it cannot drift.
        let source = try String(
            contentsOf: FixtureConformanceTests.fixtures
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("src/protocol-version.ts"),
            encoding: .utf8)
        for capability in HubCapability.allCases where capability.isAdvertisedByDaemons {
            #expect(
                source.contains("\(capability.rawValue): '\(capability.cannotText)'"),
                "\(capability.rawValue) text drifted")
        }
    }

    @Test func currentFixtureSupportsWorkspaces() throws {
        let ack = try Self.ack("hello_ack")
        #expect(ack.protocolVersion == .number(1))
        #expect(HubSupport.check(ack, needs: [.workspaces]) == .supported)
        #expect(HubSupport.check(ack) == .supported)
    }

    @Test func machineFixtureSupportsWorkspaces() throws {
        #expect(HubSupport.check(try Self.ack("hello_ack_machine"), needs: [.workspaces]).isSupported)
    }

    @Test func legacyFixtureIsVersionOneWithNoCapabilities() throws {
        let ack = try Self.ack("hello_ack_legacy")
        #expect(ack.protocolVersion == .absent)
        #expect(ack.capabilities.isEmpty)
        #expect(HubSupport.check(ack) == .supported)
        #expect(
            HubSupport.check(ack, needs: [.workspaces])
                == .unsupported(
                    reason: .capabilities, missing: ["workspaces"],
                    message:
                        "This machine's remi (0.7.4-dev.1) cannot start a session in a new git worktree. \(Self.updateMachine)"
                ))
        let newer = HubSupport.check(ack, clientVersion: 2)
        #expect(
            newer
                == .unsupported(
                    reason: .protocolVersion, missing: [],
                    message:
                        "This machine's remi (0.7.4-dev.1) speaks protocol version 1, and this app speaks version 2. \(Self.updateMachine)"
                ))
    }

    @Test func fileFixturesDecodeThroughTheTypedAck() throws {
        let typed = try JSONDecoder().decode(HelloAckMessage.self, from: FixtureConformanceTests.fixture("hello_ack"))
        #expect(HubSupportAck(typed) == (try Self.ack("hello_ack")))
        let legacy = try JSONDecoder().decode(
            HelloAckMessage.self, from: FixtureConformanceTests.fixture("hello_ack_legacy"))
        #expect(HubSupportAck(legacy).protocolVersion == .absent)
    }

    @Test func reservedAndLaterCapabilitiesAreNotListedByTheFixtures() throws {
        for fixture in ["hello_ack", "hello_ack_legacy", "hello_ack_machine"] {
            let ack = try Self.ack(fixture)
            for capability in [HubCapability.fileDownload, .imageStaging, .imageInsertion, .terminalView] {
                #expect(!HubSupport.check(ack, needs: [capability]).isSupported, "\(fixture) \(capability)")
            }
        }
        let message = HubSupport.check(try Self.ack("hello_ack"), needs: [.terminalView]).message
        #expect(message?.hasSuffix(Self.updateMachine) == true)
        #expect(message?.contains("show the terminal of the attached session") == true)
    }

    // MARK: protocol-version.test.ts

    private let current = HubSupportAck(protocolVersion: .number(1), capabilities: [], daemonVersion: "0.7.17")

    @Test func listedCapabilitiesAreSupportedAndMissingOnesNamedOnce() {
        let ack = HubSupportAck(protocolVersion: .number(1), capabilities: ["a", "c"], daemonVersion: "0.7.17")
        #expect(HubSupport.check(ack, needs: ["a", "c"]) == .supported)
        let result = HubSupport.check(ack, needs: ["a", "b", "b", "d"])
        #expect(
            result
                == .unsupported(
                    reason: .capabilities, missing: ["b", "d"],
                    message: "This machine's remi (0.7.17) cannot b; d. \(Self.updateMachine)"))
    }

    @Test func unknownDaemonNamesAreIgnored() throws {
        let json = try WireJSON.parse(
            #"{"protocolVersion":1,"capabilities":["from.the.future",7,null],"daemonVersion":"0.7.17"}"#)
        #expect(HubSupport.check(HubSupportAck(json: json)) == .supported)
    }

    @Test func aCapabilitiesFieldThatIsNotAListCountsAsNone() throws {
        for value in [#""a""#, #"{"a":true}"#, "null", "3"] {
            let json = try WireJSON.parse(#"{"protocolVersion":1,"capabilities":\#(value)}"#)
            let result = HubSupport.check(HubSupportAck(json: json), needs: ["a"])
            guard case .unsupported(_, let missing, _) = result else {
                Issue.record("\(value) was supported")
                continue
            }
            #expect(missing == ["a"])
        }
    }

    @Test func inheritedNamesAreNotRegistryKeys() {
        let result = HubSupport.check(current, needs: ["constructor", "toString"])
        #expect(result.message == "This machine's remi (0.7.17) cannot constructor; toString. \(Self.updateMachine)")
    }

    @Test func aNewerVersionNamesTheAppAsTheSideToUpdate() {
        let ack = HubSupportAck(protocolVersion: .number(2), daemonVersion: "0.7.17")
        #expect(
            HubSupport.check(ack)
                == .unsupported(
                    reason: .protocolVersion, missing: [],
                    message:
                        "This machine's remi (0.7.17) speaks protocol version 2, and this app speaks version 1. Update this app."
                ))
    }

    @Test func anOlderVersionNamesTheMachineAsTheSideToUpdate() {
        #expect(
            HubSupport.check(current, clientVersion: 2)
                == .unsupported(
                    reason: .protocolVersion, missing: [],
                    message:
                        "This machine's remi (0.7.17) speaks protocol version 1, and this app speaks version 2. \(Self.updateMachine)"
                ))
    }

    @Test func aVersionThatIsNotAPositiveIntegerIsUnreadable() throws {
        for value in [#""1""#, "0", "-1", "1.5", "null", "true", "[1]"] {
            let json = try WireJSON.parse(#"{"protocolVersion":\#(value),"daemonVersion":"0.7.17"}"#)
            #expect(
                HubSupport.check(HubSupportAck(json: json))
                    == .unsupported(
                        reason: .protocolVersion, missing: [],
                        message:
                            "This machine's remi (0.7.17) sent a protocol version this app cannot read. \(Self.updateMachine) Update this app too."
                    ), "\(value)")
        }
        let nan = HubSupportAck(protocolVersion: .number(.nan), daemonVersion: "0.7.17")
        #expect(HubSupport.check(nan).message?.contains("cannot read") == true)
    }

    @Test func theVersionCheckComesBeforeTheCapabilities() {
        let ack = HubSupportAck(protocolVersion: .number(2))
        guard case .unsupported(let reason, _, _) = HubSupport.check(ack, needs: ["a"]) else {
            Issue.record("supported")
            return
        }
        #expect(reason == .protocolVersion)
    }

    @Test func theDaemonVersionIsLeftOutWhenAbsentOrEmpty() {
        for version in [nil, ""] {
            let ack = HubSupportAck(daemonVersion: version)
            #expect(HubSupport.check(ack, needs: ["a"]).message == "This machine's remi cannot a. \(Self.updateMachine)")
        }
    }

    @Test func theDaemonVersionIsEscapedOnOneLine() {
        func message(_ version: String) -> String? {
            HubSupport.check(HubSupportAck(daemonVersion: version), needs: ["a"]).message
        }
        #expect(
            message("0.7.17\u{202E}evil\n")
                == "This machine's remi (0.7.17\\u202Eevil\\u000A) cannot a. \(Self.updateMachine)")
        #expect(message("0.7\t17") == "This machine's remi (0.7\\u000917) cannot a. \(Self.updateMachine)")
    }

    @Test func theDaemonVersionIsCutAtFortyCodePoints() {
        func message(_ version: String) -> String? {
            HubSupport.check(HubSupportAck(daemonVersion: version), needs: ["a"]).message
        }
        let long = String(repeating: "9", count: 39) + "\u{1F600}tail"
        #expect(
            message(long)
                == "This machine's remi (\(String(repeating: "9", count: 39))\u{1F600}...) cannot a. \(Self.updateMachine)")
        let exact = String(repeating: "8", count: 40)
        #expect(message(exact) == "This machine's remi (\(exact)) cannot a. \(Self.updateMachine)")
    }
}
