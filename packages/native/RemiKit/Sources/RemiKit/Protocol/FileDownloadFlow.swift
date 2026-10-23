import Foundation

/// Why a typed path cannot be sent, with the same rules as the wire (ADR 0045):
/// 1 to 4,096 bytes, at most 64 components, each nonempty, at most 255 bytes, and none holding a
/// colon, backslash, control or bidirectional character. The wire repeats these checks; this
/// tells the person what to fix before sending.
public enum FileDownloadPathIssue: Error, Sendable, Equatable {
    case empty
    case tooLong
    case tooManyComponents
    case emptyComponent
    case componentTooLong
    case unsafeCharacter

    public var text: String {
        switch self {
        case .empty: "Enter the path of a file in the session workspace."
        case .tooLong: "That path is longer than \(FileFetchLimits.relativePathBytes) bytes."
        case .tooManyComponents: "That path has more than \(FileFetchLimits.pathComponents) folders and names."
        case .emptyComponent: "A path cannot start or end with a slash or hold an empty name between slashes."
        case .componentTooLong: "A name in that path is longer than \(FileFetchLimits.pathComponentBytes) bytes."
        case .unsafeCharacter: "A name in that path holds a colon, backslash, or an invisible control character."
        }
    }
}

public enum FileDownloadPath {
    /// The first rule the path breaks, nil when the wire would accept it.
    public static func issue(in path: String) -> FileDownloadPathIssue? {
        guard !path.isEmpty else { return .empty }
        guard path.utf8.count <= FileFetchLimits.relativePathBytes else { return .tooLong }
        let components = path.unicodeScalars.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count <= FileFetchLimits.pathComponents else { return .tooManyComponents }
        for component in components {
            guard !component.isEmpty else { return .emptyComponent }
            guard String(component).utf8.count <= FileFetchLimits.pathComponentBytes else { return .componentTooLong }
            if component.contains(where: { FileFetchMessage.isUnsafeComponentScalar($0) }) { return .unsafeCharacter }
        }
        return nil
    }

    /// The last component, for the person to see before and after a download.
    public static func baseName(of path: String) -> String {
        path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? path
    }
}

/// One download as the app drives it: the strict state machine plus what the screen shows.
/// Pure; the store supplies request ids, the wall clock text and the monotonic time.
public struct FileDownloadFlow: Sendable, Equatable {
    public let sessionId: String
    public let relativePath: String
    public private(set) var machine: FileFetchStateMachine

    /// Starts a download: nil with the issue when the path would be refused. `message` is the
    /// `file_fetch_begin` frame to send.
    public static func begin(
        path: String, binding: AttachedBinding, sessionId: String, requestId: String, timestamp: String,
        now: TimeInterval
    ) -> Result<(flow: FileDownloadFlow, message: FileFetchMessage), FileDownloadPathIssue> {
        if let issue = FileDownloadPath.issue(in: path) { return .failure(issue) }
        let header = WireHeader(id: requestId, timestamp: timestamp, sessionId: sessionId)
        let flow = FileDownloadFlow(
            sessionId: sessionId, relativePath: path, machine: FileFetchStateMachine(beginId: requestId, now: now))
        return .success((flow, .begin(FileFetchBegin(header: header, binding: binding, relativePath: path))))
    }

    /// Feeds an event and returns the frames to send. `makeID` and `timestamp` stamp them.
    public mutating func handle(
        _ event: FileFetchStateMachine.Event, now: TimeInterval, makeID: () -> String, timestamp: String
    ) -> [FileFetchMessage] {
        // A frame for another session is not ours.
        if case .message(let message) = event, let session = message.sessionId,
            !WireGuards.same(session, sessionId)
        {
            return []
        }
        return machine.handle(event, at: now).map { action in
            let header = WireHeader(id: makeID(), timestamp: timestamp, sessionId: sessionId)
            switch action {
            case .sendRead(let transferId, let seq, let receivedBytes):
                return .read(FileFetchRead(header: header, transferId: transferId, seq: seq, receivedBytes: receivedBytes))
            case .sendComplete(let transferId, let receivedBytes, let digest):
                return .complete(
                    FileFetchComplete(header: header, transferId: transferId, receivedBytes: receivedBytes, digest: digest))
            case .sendCancel(let beginId):
                return .cancel(FileFetchCancel(header: header, beginId: beginId))
            }
        }
    }

    /// The connection dropped or a frame could not be sent: the partial file is discarded.
    public mutating func markDisconnected(now: TimeInterval) {
        _ = machine.handle(.disconnected, at: now)
    }

    /// What the screen shows. Derived, so it cannot disagree with the machine.
    public enum Status: Sendable, Equatable {
        case requesting
        /// `total` is the file's size in bytes once accepted.
        case receiving(received: Int, total: Int, fileName: String)
        case verified(fileName: String, byteCount: Int, hostSettled: Bool)
        case failed(String)
        case cancelled
    }

    public var status: Status {
        switch machine.phase {
        case .awaitingAcceptance: return .requesting
        case .receiving, .awaitingResult:
            return .receiving(received: machine.receivedBytes, total: machine.byteLength, fileName: machine.fileName)
        case .finished(let outcome):
            switch outcome {
            case .verified(let file, let settled):
                return .verified(fileName: file.fileName, byteCount: file.data.count, hostSettled: settled)
            case .cancelled: return .cancelled
            case .failed(let failure): return .failed(Self.text(for: failure))
            }
        }
    }

    /// The verified bytes, only once the whole file matched its digest. Nil before, and after a failure or cancel.
    public var verifiedFile: FileFetchStateMachine.VerifiedFile? {
        if case .finished(.verified(let file, _)) = machine.phase { return file }
        return nil
    }

    public var isFinished: Bool { machine.isFinished }

    public static func text(for failure: FileFetchStateMachine.Failure) -> String {
        switch failure {
        case .sequence, .integrity:
            "The file did not arrive intact, so nothing was kept. Try again."
        case .noProgress: "The download stalled and was stopped. Nothing was kept."
        case .lifetimeExpired: "The download took too long and was stopped. Nothing was kept."
        case .disconnected: "The connection dropped. Nothing was kept; start the download again."
        case .protocolViolation: "The machine sent something this app does not accept, so the download was stopped."
        case .refused(let code): text(for: code)
        }
    }

    public static func text(for code: FileFetchRefusalCode) -> String {
        switch code {
        case .malformed: "This app asked in a way the machine could not read. Update this app and the remi on that machine."
        case .unavailable: "The machine will not send that file. It may not exist, may be outside the workspace, or may be protected."
        case .busy: "The machine is already sending as many files as it allows. Try again in a moment."
        case .conflict: "Another download for this session is already running."
        case .sequence, .integrity: "The file did not arrive intact, so nothing was kept. Try again."
        case .emptyFile: "That file is empty, so there is nothing to download."
        case .expired: "The download timed out on the machine. Nothing was kept."
        case .bindingChanged: "This session now belongs to a different conversation. Nothing was kept."
        case .cleanupFailed: "The machine could not finish cleaning up. Nothing was kept."
        }
    }
}
