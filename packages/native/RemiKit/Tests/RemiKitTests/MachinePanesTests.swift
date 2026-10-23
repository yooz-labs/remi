import Foundation
import Testing
@testable import RemiKit

#if DEBUG
/// The store's pane entry points against real decoded frames at its post-verification boundary
/// (as ChildRouteOriginTests does). No frame can be sent today: every route is blocked.
@MainActor
struct MachinePanesTests {
    private var descriptor: [String: Any] {
        get throws {
            ["id": try MachineIdentityVerifier.machineID(forPublicKey: Data(repeating: 9, count: 32)),
             "name": "Pane Mac", "platform": "darwin", "remiVersion": "0.8.0", "harnesses": ["claude"], "capabilities": []]
        }
    }

    private func frame<T: Decodable>(_ fields: [String: Any]) throws -> T {
        var object = fields
        object["id"] = UUID().uuidString
        object["timestamp"] = "2026-10-20T06:00:00Z"
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A connected machine whose ack lists `capabilities`, with the golden session list.
    private func connectedStore(_ capabilities: [String]) throws -> (MachineStore, String) {
        let origin = MachineEndpoint(host: "192.0.2.40", port: 28040)
        let store = MachineStore(endpoints: [origin], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let generation = try #require(store.connectionGenerations[origin])
        let ack: HelloAckMessage = try frame([
            "type": "hello_ack", "serverVersion": "1.0.0", "protocolVersion": 1, "capabilities": capabilities,
            "machine": descriptor,
        ])
        store.receive(.hello(ack), from: origin, generation: generation)
        store.receive(.connected(sessionId: nil), from: origin, generation: generation)
        let list = try JSONDecoder().decode(
            SessionListResponse.self, from: FixtureConformanceTests.fixture("session_list_response"))
        store.receive(.sessions(list), from: origin, generation: generation)
        return (store, try #require(store.machines.first?.id))
    }

    @Test func sessionListKeepsTheHarnessSessionId() throws {
        let (store, _) = try connectedStore([])
        defer { store.stop() }
        #expect(store.machines.first?.sessions.first?.harnessSessionId == "fixture-claude-session-id")
    }

    @Test func machineWithoutTheCapabilityIsToldToUpdate() throws {
        let (store, machine) = try connectedStore(["workspaces"])
        defer { store.stop() }
        guard case .blocked(let reason) = store.openTerminal(machineID: machine, sessionID: "fixture-session-id") else {
            Issue.record("started")
            return
        }
        #expect(reason.contains("cannot show the terminal of the attached session"))
        #expect(store.terminalViews.isEmpty)
        guard case .blocked(let files) = store.beginFileDownload(
            machineID: machine, sessionID: "fixture-session-id", path: "a.txt")
        else {
            Issue.record("started")
            return
        }
        #expect(files.contains("download a file from the attached session"))
        #expect(store.fileDownloads.isEmpty)
    }

    @Test func advertisedCapabilityStillSendsNothingWithoutASecureRoute() throws {
        let (store, machine) = try connectedStore(["terminal_view", "file_download"])
        defer { store.stop() }
        let terminal = store.openTerminal(machineID: machine, sessionID: "fixture-session-id")
        let file = store.beginFileDownload(machineID: machine, sessionID: "fixture-session-id", path: "a.txt")
        for result in [terminal, file] {
            guard case .blocked(let reason) = result else {
                Issue.record("started")
                continue
            }
            #expect(reason.contains("secure connection") || reason.contains("not connected"))
        }
        #expect(store.terminalViews.isEmpty && store.fileDownloads.isEmpty)
        #expect(store.paneBlock(machineID: machine, sessionID: "fixture-session-id", needs: .terminalView) != nil)
    }

    @Test func inboundFramesWithoutAViewAreIgnored() throws {
        let (store, machine) = try connectedStore(["terminal_view"])
        defer { store.stop() }
        let origin = try #require(store.machines.first?.endpoint)
        let generation = try #require(store.connectionGenerations[origin])
        let snapshot = try TerminalViewMessage.decode(FixtureConformanceTests.fixture("session_terminal_snapshot"))
        store.receive(.terminalView(snapshot), from: origin, generation: generation)
        let accepted = try FileFetchMessage.decode(FixtureConformanceTests.fixture("file_fetch_accepted"))
        store.receive(.fileFetch(accepted), from: origin, generation: generation)
        store.tickPanes()
        #expect(store.terminalViews.isEmpty && store.fileDownloads.isEmpty)
        #expect(store.terminalView(machineID: machine, sessionID: "x") == nil)
    }
}
#endif
