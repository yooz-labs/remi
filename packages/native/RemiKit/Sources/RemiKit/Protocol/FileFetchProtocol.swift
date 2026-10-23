import Foundation

/// Limits of ADR 0045, mirroring `FILE_DOWNLOAD_LIMITS` in `packages/shared/src/file-download.ts`.
public enum FileFetchLimits {
    public static let frameBytes = WireJSON.maxFrameBytes
    public static let relativePathBytes = 4_096
    public static let pathComponents = 64
    public static let pathComponentBytes = 255
    public static let fileNameBytes = 255
    public static let fileBytes = 10_485_760
    public static let chunkBytes = 32_768
    public static let maxSequence = 319
}

/// The four client requests a refusal can name.
public enum FileFetchOperation: String, Sendable, Equatable, CaseIterable {
    case begin = "file_fetch_begin"
    case read = "file_fetch_read"
    case complete = "file_fetch_complete"
    case cancel = "file_fetch_cancel"
}

public enum FileFetchRefusalCode: String, Sendable, Equatable, CaseIterable {
    case malformed
    case unavailable
    case busy
    case conflict
    case sequence
    case integrity
    case emptyFile = "empty_file"
    case expired
    case bindingChanged = "binding_changed"
    case cleanupFailed = "cleanup_failed"
}

/// Client to host: begin one explicit read of a project-relative file. Syntax only: no
/// denied-name, protected-root or filesystem check happens here, and none grants access.
public struct FileFetchBegin: Sendable, Equatable {
    public let header: WireHeader
    public let binding: AttachedBinding
    public let relativePath: String

    public init(header: WireHeader, binding: AttachedBinding, relativePath: String) {
        self.header = header
        self.binding = binding
        self.relativePath = relativePath
    }
}

/// Host to client: the private copy passed validation; no content has been sent.
public struct FileFetchAccepted: Sendable, Equatable {
    public let header: WireHeader
    /// The begin request's `id`.
    public let requestId: String
    public let transferId: String
    /// Inert display and save-name data, never a client filesystem path.
    public let fileName: String
    public let byteLength: Int
    /// SHA-256 of the copy, canonical unpadded base64url (43 characters).
    public let digest: String
    public let expiresAt: String

    /// Always `application/octet-stream`; there is no content sniffing.
    public static let mediaType = "application/octet-stream"

    public init(
        header: WireHeader, requestId: String, transferId: String, fileName: String, byteLength: Int, digest: String,
        expiresAt: String
    ) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
        self.fileName = fileName
        self.byteLength = byteLength
        self.digest = digest
        self.expiresAt = expiresAt
    }
}

/// Client to host: acknowledges every byte before `seq` and pulls chunk `seq`.
public struct FileFetchRead: Sendable, Equatable {
    public let header: WireHeader
    public let transferId: String
    public let seq: Int
    public let receivedBytes: Int

    public init(header: WireHeader, transferId: String, seq: Int, receivedBytes: Int) {
        self.header = header
        self.transferId = transferId
        self.seq = seq
        self.receivedBytes = receivedBytes
    }
}

/// Host to client: one bounded chunk, `data` canonical unpadded base64url.
public struct FileFetchChunk: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String
    public let seq: Int
    public let data: String

    public init(header: WireHeader, requestId: String, transferId: String, seq: Int, data: String) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
        self.seq = seq
        self.data = data
    }

    /// The decoded bytes (1 through 32,768).
    public var bytes: Data? { WireGuards.decodeBase64URL(data) }
}

/// Client to host: claims local exact-length and digest verification.
public struct FileFetchComplete: Sendable, Equatable {
    public let header: WireHeader
    public let transferId: String
    public let receivedBytes: Int
    public let digest: String

    public init(header: WireHeader, transferId: String, receivedBytes: Int, digest: String) {
        self.header = header
        self.transferId = transferId
        self.receivedBytes = receivedBytes
        self.digest = digest
    }
}

/// Host to client: the host copy was closed, deleted and settled. Not a Save receipt.
public struct FileFetchResult: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String

    public init(header: WireHeader, requestId: String, transferId: String) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
    }
}

/// Client to host: cancels the owned operation, even before a transfer ID exists.
public struct FileFetchCancel: Sendable, Equatable {
    public let header: WireHeader
    public let beginId: String

    public init(header: WireHeader, beginId: String) {
        self.header = header
        self.beginId = beginId
    }
}

public struct FileFetchCancelResult: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let beginId: String

    public init(header: WireHeader, requestId: String, beginId: String) {
        self.header = header
        self.requestId = requestId
        self.beginId = beginId
    }
}

public struct FileFetchRefused: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let operation: FileFetchOperation
    public let code: FileFetchRefusalCode

    public init(header: WireHeader, requestId: String, operation: FileFetchOperation, code: FileFetchRefusalCode) {
        self.header = header
        self.requestId = requestId
        self.operation = operation
        self.code = code
    }
}

/// The nine `file_fetch_*` messages (ADR 0045). Structural validity only.
public enum FileFetchMessage: Sendable, Equatable {
    case begin(FileFetchBegin)
    case accepted(FileFetchAccepted)
    case read(FileFetchRead)
    case chunk(FileFetchChunk)
    case complete(FileFetchComplete)
    case result(FileFetchResult)
    case cancel(FileFetchCancel)
    case cancelResult(FileFetchCancelResult)
    case refused(FileFetchRefused)

    public static func decode(_ data: Data) throws -> FileFetchMessage {
        try decode(json: try WireJSON.parse(data))
    }

    public static func decode(_ text: String) throws -> FileFetchMessage {
        try decode(Data(text.utf8))
    }

    public static func decode(json: WireJSON) throws -> FileFetchMessage {
        guard let type = wireType(json) else { throw WireFrameError.invalid("type") }
        func fields(_ response: Bool, _ rest: [String]) throws -> WireFields {
            try WireFields(json, keys: wireKeys(response: response, rest))
        }
        let transferBytes = 16...16
        let digestBytes = 32...32
        let sequence = 0...FileFetchLimits.maxSequence
        let received = 0...FileFetchLimits.fileBytes
        switch type {
        case "file_fetch_begin":
            let f = try fields(false, ["binding", "relativePath"])
            let path = try f.string("relativePath")
            guard isRelativePath(path) else { throw WireFrameError.invalid("relativePath") }
            return .begin(FileFetchBegin(header: try f.header(), binding: try f.binding("binding"), relativePath: path))
        case "file_fetch_accepted":
            let f = try fields(
                true, ["transferId", "fileName", "byteLength", "mediaType", "digest", "expiresAt"])
            let name = try f.string("fileName")
            guard isFileName(name) else { throw WireFrameError.invalid("fileName") }
            guard WireGuards.same(try f.string("mediaType"), FileFetchAccepted.mediaType) else {
                throw WireFrameError.invalid("mediaType")
            }
            return .accepted(
                FileFetchAccepted(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: transferBytes), fileName: name,
                    byteLength: try f.integer("byteLength", in: 1...FileFetchLimits.fileBytes),
                    digest: try f.encoded("digest", bytes: digestBytes), expiresAt: try f.timestamp("expiresAt")))
        case "file_fetch_read":
            let f = try fields(false, ["transferId", "seq", "receivedBytes"])
            return .read(
                FileFetchRead(
                    header: try f.header(), transferId: try f.encoded("transferId", bytes: transferBytes),
                    seq: try f.integer("seq", in: sequence), receivedBytes: try f.integer("receivedBytes", in: received)))
        case "file_fetch_chunk":
            let f = try fields(true, ["transferId", "seq", "data"])
            return .chunk(
                FileFetchChunk(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: transferBytes),
                    seq: try f.integer("seq", in: sequence),
                    data: try f.encoded("data", bytes: 1...FileFetchLimits.chunkBytes)))
        case "file_fetch_complete":
            let f = try fields(false, ["transferId", "receivedBytes", "digest"])
            return .complete(
                FileFetchComplete(
                    header: try f.header(), transferId: try f.encoded("transferId", bytes: transferBytes),
                    receivedBytes: try f.integer("receivedBytes", in: received),
                    digest: try f.encoded("digest", bytes: digestBytes)))
        case "file_fetch_result":
            let f = try fields(true, ["transferId", "outcome"])
            guard WireGuards.same(try f.string("outcome"), "complete") else { throw WireFrameError.invalid("outcome") }
            return .result(
                FileFetchResult(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: transferBytes)))
        case "file_fetch_cancel":
            let f = try fields(false, ["beginId"])
            return .cancel(FileFetchCancel(header: try f.header(), beginId: try f.uuid4("beginId")))
        case "file_fetch_cancel_result":
            let f = try fields(true, ["beginId", "outcome"])
            guard WireGuards.same(try f.string("outcome"), "cancelled") else { throw WireFrameError.invalid("outcome") }
            return .cancelResult(
                FileFetchCancelResult(
                    header: try f.header(), requestId: try f.uuid4("requestId"), beginId: try f.uuid4("beginId")))
        case "file_fetch_refused":
            let f = try fields(true, ["operation", "code"])
            return .refused(
                FileFetchRefused(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    operation: try f.oneOf("operation", FileFetchOperation.self),
                    code: try f.oneOf("code", FileFetchRefusalCode.self)))
        default:
            throw WireFrameError.invalid("type")
        }
    }

    /// Characters no path component or file name may hold: separators, backslash, colon,
    /// controls and misleading direction controls.
    private static func isUnsafeComponentScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x2F, 0x3A, 0x5C, 0x00...0x1F, 0x7F...0x9F, 0x061C, 0x200E, 0x200F, 0x202A...0x202E, 0x2066...0x2069:
            true
        default: false
        }
    }

    /// Structural path syntax only: 1 to 4,096 bytes, at most 64 nonempty components of at most
    /// 255 bytes. No normalization, and no denied-name or filesystem check.
    static func isRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= FileFetchLimits.relativePathBytes else { return false }
        let components = path.unicodeScalars.split(separator: "/", omittingEmptySubsequences: false)
        return components.count <= FileFetchLimits.pathComponents
            && components.allSatisfy { component in
                !component.isEmpty && String(component).utf8.count <= FileFetchLimits.pathComponentBytes
                    && !component.contains(where: isUnsafeComponentScalar)
            }
    }

    /// Inert basename syntax only; equality with the request path is a later check.
    static func isFileName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= FileFetchLimits.fileNameBytes
            && !name.unicodeScalars.contains(where: isUnsafeComponentScalar)
    }

    public var json: WireJSON {
        switch self {
        case .begin(let m):
            return wireObject(
                type: "file_fetch_begin", header: m.header,
                [("binding", m.binding.json), ("relativePath", .string(m.relativePath))])
        case .accepted(let m):
            return wireObject(
                type: "file_fetch_accepted", header: m.header, requestId: m.requestId,
                [
                    ("transferId", .string(m.transferId)), ("fileName", .string(m.fileName)),
                    ("byteLength", .number(Double(m.byteLength))), ("mediaType", .string(FileFetchAccepted.mediaType)),
                    ("digest", .string(m.digest)), ("expiresAt", .string(m.expiresAt)),
                ])
        case .read(let m):
            return wireObject(
                type: "file_fetch_read", header: m.header,
                [
                    ("transferId", .string(m.transferId)), ("seq", .number(Double(m.seq))),
                    ("receivedBytes", .number(Double(m.receivedBytes))),
                ])
        case .chunk(let m):
            return wireObject(
                type: "file_fetch_chunk", header: m.header, requestId: m.requestId,
                [("transferId", .string(m.transferId)), ("seq", .number(Double(m.seq))), ("data", .string(m.data))])
        case .complete(let m):
            return wireObject(
                type: "file_fetch_complete", header: m.header,
                [
                    ("transferId", .string(m.transferId)), ("receivedBytes", .number(Double(m.receivedBytes))),
                    ("digest", .string(m.digest)),
                ])
        case .result(let m):
            return wireObject(
                type: "file_fetch_result", header: m.header, requestId: m.requestId,
                [("transferId", .string(m.transferId)), ("outcome", .string("complete"))])
        case .cancel(let m):
            return wireObject(type: "file_fetch_cancel", header: m.header, [("beginId", .string(m.beginId))])
        case .cancelResult(let m):
            return wireObject(
                type: "file_fetch_cancel_result", header: m.header, requestId: m.requestId,
                [("beginId", .string(m.beginId)), ("outcome", .string("cancelled"))])
        case .refused(let m):
            return wireObject(
                type: "file_fetch_refused", header: m.header, requestId: m.requestId,
                [("operation", .string(m.operation.rawValue)), ("code", .string(m.code.rawValue))])
        }
    }

    /// The frame text, or `WireFrameError.invalid("frame")` when this value would not survive the strict decoder.
    ///
    /// The round-trip check uses `==`, which compares `String` by canonical equivalence, so it
    /// proves shape, not scalar identity: never use `==` on these models to compare identifiers
    /// (use `WireGuards.same`, which compares UTF-8 bytes).
    public func encodedFrame() throws -> String {
        let text = json.serialized()
        guard let decoded = try? Self.decode(text), decoded == self else { throw WireFrameError.invalid("frame") }
        return text
    }
}
