import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
import Darwin

private enum PeerStartupError: Error, Equatable {
    case timedOut, oversized, closed
    case system(Int32)
}

/// PID alone is not authority to signal a process: require the original parent
/// and kernel start time as well as the Process object's running state.
private struct PeerIdentity: Equatable {
    let pid: Int32
    let parent: UInt32
    let startedSeconds: UInt64
    let startedMicroseconds: UInt64

    static func capture(_ pid: Int32) -> PeerIdentity? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
              info.pbi_pid == UInt32(pid), info.pbi_ppid == UInt32(getpid()) else { return nil }
        return PeerIdentity(pid: pid, parent: info.pbi_ppid,
            startedSeconds: info.pbi_start_tvsec, startedMicroseconds: info.pbi_start_tvusec)
    }
}

private struct PeerExit: Sendable {
    let status: Int32
    let signaled: Bool
}

private final class PeerExitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var value: PeerExit?
    private func set(_ result: PeerExit) { lock.lock(); defer { lock.unlock() }; value = result }
    func get() -> PeerExit? { lock.lock(); defer { lock.unlock() }; return value }

    // Constructed outside MainActor so Foundation's termination callback has no
    // inherited executor requirement when it runs on its own queue.
    static func handler(_ recorder: PeerExitRecorder) -> @Sendable (Process) -> Void {
        { process in
            recorder.set(PeerExit(status: process.terminationStatus,
                signaled: process.terminationReason == .uncaughtSignal))
        }
    }
}

@MainActor private final class OwnedAnswerPeer {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let exit = PeerExitRecorder()
    private(set) var identity: PeerIdentity?

    init(mode: String, directory: URL) throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/answer-outcome-peer.ts")
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", script.path, mode]
        process.currentDirectoryURL = directory
        process.environment = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        process.standardOutput = output
        process.standardInput = input
        process.standardError = FileHandle.standardError
        process.terminationHandler = PeerExitRecorder.handler(exit)
        try process.run()
        identity = PeerIdentity.capture(process.processIdentifier)
    }

    /// The peer cannot keep a test open indefinitely or grow its startup buffer.
    func startup(timeout: Duration = .seconds(8), maximumBytes: Int = 4096) async throws -> Data {
        let fd = output.fileHandleForReading.fileDescriptor
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0 else { throw PeerStartupError.system(errno) }
        let deadline = ContinuousClock.now.advanced(by: timeout)
        var line = Data()
        while ContinuousClock.now < deadline {
            var bytes = [UInt8](repeating: 0, count: 256)
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count > 0 {
                for byte in bytes.prefix(count) {
                    if byte == 10 { return line }
                    guard line.count < maximumBytes else { throw PeerStartupError.oversized }
                    line.append(byte)
                }
            } else if count == 0 {
                throw PeerStartupError.closed
            } else {
                let error = errno
                guard error == EAGAIN || error == EINTR else { throw PeerStartupError.system(error) }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        throw PeerStartupError.timedOut
    }

    struct StopResult {
        let termination: PeerExit?
        let killed: Bool
    }

    func stop(grace: Duration = .seconds(3), term: Duration = .seconds(2),
              kill: Duration = .seconds(2)) async -> StopResult {
        defer { try? output.fileHandleForReading.close() }
        try? input.fileHandleForWriting.close()
        if let result = await waitForExit(grace) { return StopResult(termination: result, killed: false) }
        if isSameRunningChild { process.terminate() }
        if let result = await waitForExit(term) { return StopResult(termination: result, killed: false) }
        var killed = false
        if isSameRunningChild, let identity {
            killed = Darwin.kill(identity.pid, SIGKILL) == 0
        }
        return StopResult(termination: await waitForExit(kill), killed: killed)
    }

    private var isSameRunningChild: Bool {
        guard process.isRunning, let identity else { return false }
        return PeerIdentity.capture(identity.pid) == identity
    }

    private func waitForExit(_ duration: Duration) async -> PeerExit? {
        let deadline = ContinuousClock.now.advanced(by: duration)
        while ContinuousClock.now < deadline {
            if let result = exit.get() { return result }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return exit.get()
    }
}

/// An adversarial local peer tests the real direct connection and Store; it does
/// not replace daemon business logic or claim a device/relay qualification.
@MainActor @Suite(.serialized)
struct AnswerOutcomeWireTests {
    @Test(arguments: ["startup-stalled", "startup-oversized"])
    func startupFailureIsBoundedAndOwnedPeerIsReaped(_ mode: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-answer-startup-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        var owner: OwnedAnswerPeer?
        defer {
            if owner == nil || owner?.exit.get() != nil { try? FileManager.default.removeItem(at: directory) }
        }
        let peer = try OwnedAnswerPeer(mode: mode, directory: directory)
        owner = peer
        do {
            _ = try await peer.startup(timeout: .milliseconds(500), maximumBytes: 1024)
            Issue.record("The \(mode) control unexpectedly returned a startup frame")
        } catch let error as PeerStartupError {
            #expect(error == (mode == "startup-stalled" ? .timedOut : .oversized))
        } catch {
            Issue.record("Unexpected startup error: \(error)")
        }
        // The stalled peer deliberately ignores SIGTERM, so this also exercises
        // the exact PID/start-time guarded SIGKILL path and termination receipt.
        let stopped = await peer.stop(grace: .milliseconds(100), term: .milliseconds(200))
        let result = try #require(stopped.termination, "Owned peer did not produce a termination receipt")
        #expect(!peer.process.isRunning)
        if mode == "startup-stalled" {
            #expect(stopped.killed)
            #expect(result.signaled && result.status == SIGKILL)
        }
    }

    @Test(arguments: [
        ("delivered", "delivered"), ("stale", "stale"),
        ("stale-binding", "stale"), ("session-not-found", "stale"),
        ("conflict", "conflict"), ("busy", "busy"), ("uncertain", "uncertain"),
        ("future-outcome", "uncertain"), ("STALE-BINDING", "uncertain"), ("refused", "uncertain"),
    ])
    func secureNotificationOutcomeUsesTheSharedWireVocabulary(input: String, expected: String) {
        #expect(RelayNotificationAnswerOutcome.fromWire(input).rawValue == expected)
    }

    @Test(arguments: ["delivered", "stale", "stale-binding", "session-not-found", "conflict", "busy", "uncertain", "future-outcome", "STALE-BINDING", "non-string", "mismatch-request", "mismatch-session", "mismatch-question"])
    func localNotificationClassifiesCorrelatedWireOutcome(_ wireOutcome: String) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-answer-outcome-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        var owner: OwnedAnswerPeer?
        defer {
            if owner == nil || owner?.exit.get() != nil { try? FileManager.default.removeItem(at: directory) }
        }
        let peer = try OwnedAnswerPeer(mode: wireOutcome, directory: directory)
        owner = peer
        var store: MachineStore?
        do {
            let line = try await peer.startup()
            let metadata = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let port = try #require(metadata["port"] as? Int)
            let publicKey = try #require(metadata["publicKey"] as? String)
            let sessionId = try #require(metadata["sessionId"] as? String)
            let questionId = try #require(metadata["questionId"] as? String)
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: port, expectedPublicKey: publicKey)
            let current = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "owned", clientId: "owned")
            store = current
            current.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if current.machines.first?.status == .connected, current.machines.first?.questions.count == 1 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let machine = try #require(current.machines.first)
            #expect(machine.status == .connected)
            let destination = RemiNavigationDestination(machineID: machine.id, sessionID: sessionId, questionID: questionId)
            let plan = try #require(current.localQuestionNotification(for: destination))
            let outcome = await current.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.noIdentifier)
            switch wireOutcome {
            case "delivered": #expect(outcome == .delivered)
            case "stale", "stale-binding", "session-not-found", "mismatch-request", "mismatch-session", "mismatch-question": #expect(outcome == .stale)
            case "busy": #expect(outcome == .busy)
            default: #expect(outcome == .uncertain)
            }
            // A receipt alone is not authoritative question removal or permission to replay.
            #expect(current.machines.first?.questions.count == 1)
            current.stop()
        } catch {
            store?.stop()
            let stopped = await peer.stop()
            #expect(stopped.termination != nil, "Owned peer did not produce a termination receipt")
            throw error
        }
        let stopped = await peer.stop()
        _ = try #require(stopped.termination, "Owned peer did not produce a termination receipt")
        let peerResult = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("peer-result.json"))) as? [String: Int])
        #expect(peerResult["answerCount"] == 1, "The native client must not replay the answer")
    }
}
#endif
