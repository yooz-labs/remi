import Darwin
import Foundation
import Testing
@testable import RemiKit

private actor DeadlineStates {
    var values: [RemiConnectionState] = []
    func append(_ value: RemiConnectionState) { values.append(value) }
    var reachedTimeout: Bool { values.contains { if case .reachabilityFailed = $0 { return true }; return false } }
}

struct DirectConnectionDeadlineTests {
    @Test func silentRealTCPListenerCannotLeaveDirectConnectSpinning() async throws {
        // A real TCP listener accepts the kernel's connection but never sends
        // an HTTP upgrade. No app protocol or authentication is substituted.
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        #expect(descriptor >= 0)
        defer { Darwin.close(descriptor) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        #expect(bound == 0)
        #expect(Darwin.listen(descriptor, 4) == 0)
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(descriptor, $0, &size)
            }
        }
        #expect(named == 0)
        let port = UInt16(bigEndian: address.sin_port)
        let states = DeadlineStates()
        let connection = RemiConnection(configuration: RemiConnectionConfiguration(
            url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
            clientVersion: "test", clientId: "deadline-test", directConnectTimeout: .milliseconds(100)),
            identity: ClientIdentity(), stateHandler: { state in Task { await states.append(state) } },
            eventHandler: { _ in })
        await connection.start()
        let until = ContinuousClock.now.advanced(by: .seconds(3))
        while !(await states.reachedTimeout), ContinuousClock.now < until {
            try await Task.sleep(for: .milliseconds(10))
        }
        let timedOut = await states.reachedTimeout
        await connection.stop()
        #expect(timedOut)
    }
}
