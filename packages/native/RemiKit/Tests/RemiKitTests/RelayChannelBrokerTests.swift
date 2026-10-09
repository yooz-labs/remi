import Foundation
import Testing
@testable import RemiKit

private actor OwnedLaunchGate {
    var paused = false
    private var released = false
    private var pending: CheckedContinuation<Void, Never>?
    func pause() async {
        paused = true
        guard !released else { return }
        await withCheckedContinuation { pending = $0 }
    }
    func release() { released = true; pending?.resume(); pending = nil }
}
private final class OwnedLaunchReceipt: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    private var state: RemiConnectionState?
    func finish() { lock.lock(); value = true; lock.unlock() }
    func finished() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    func observe(_ current: RemiConnectionState) { lock.lock(); state = current; lock.unlock() }
    func latest() -> RemiConnectionState? { lock.lock(); defer { lock.unlock() }; return state }
}

struct RelayChannelBrokerTests {
    @Test(arguments: ["stop", "answer", "replacement"])
    func retirementWaitsForLaunchThatAlreadyPassedOwnership(kind: String) async throws {
        let gate = OwnedLaunchGate(), receipt = OwnedLaunchReceipt()
        let broker = RelayChannelBroker(ownedBeforeStart: { await gate.pause() })
        let key = UUID().uuidString, id = UUID()
        // Port zero refuses locally. Real connection actor/lifecycle, without
        // contacting an owner service or replacing any protocol/business logic.
        let url = try #require(URL(string: "ws://127.0.0.1:0/ws"))
        let connection = RemiConnection(configuration: .init(url: url, clientVersion: "owned", clientId: "owned"),
            identity: ClientIdentity(), stateHandler: { receipt.observe($0) }, eventHandler: { _ in })
        try await connection.configureOneShot()
        let adopted = broker.adopt(key: key, id: id, connection: connection, current: { true }, resume: {})
        let launch = try #require(adopted)
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !(await gate.paused), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(await gate.paused)
        var replacement: RemiConnection?
        if kind == "stop" { broker.retire(key: key, id: id) }
        if kind == "replacement" {
            let next = RemiConnection(configuration: .init(url: url, clientVersion: "owned-next", clientId: "owned-next"),
                identity: ClientIdentity(), stateHandler: { _ in }, eventHandler: { _ in })
            try await next.configureOneShot(); replacement = next
            let adoptedNext = broker.adopt(key: key, id: UUID(), connection: next, current: { true }, resume: {})
            _ = try #require(adoptedNext)
        }
        let lease = try #require(broker.claim(key: key))
        let completion = Task { await lease.retired.value; receipt.finish() }
        try await Task.sleep(for: .milliseconds(50))
        #expect(!receipt.finished(), "An already-authorized launch still owns retirement until start then stop finishes")
        await gate.release()
        await launch.value; await lease.retired.value; await completion.value
        #expect(receipt.latest() == .stopped, "No foreground actor restarts after retirement has returned")
        broker.release(lease)
        await connection.stop(); await replacement?.stop()
    }
}
