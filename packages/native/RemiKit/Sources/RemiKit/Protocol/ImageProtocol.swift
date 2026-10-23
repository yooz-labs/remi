import Foundation

/// Limits of ADR 0041, mirroring `IMAGE_STAGING_LIMITS` in `packages/shared/src/image-staging.ts`.
public enum ImageStagingLimits {
    public static let frameBytes = WireJSON.maxFrameBytes
    public static let imageBytes = 10_485_760
    public static let chunkBytes = 32_768
    public static let maxSequence = 319
}

public enum ImageMediaType: String, Sendable, Equatable, CaseIterable {
    case png = "image/png"
    case jpeg = "image/jpeg"
}

/// The four client requests an image upload refusal can name.
public enum ImageUploadOperation: String, Sendable, Equatable, CaseIterable {
    case begin = "image_upload_begin"
    case chunk = "image_upload_chunk"
    case complete = "image_upload_complete"
    case cancel = "image_upload_cancel"
}

public enum ImageUploadRefusalCode: String, Sendable, Equatable, CaseIterable {
    case malformed
    case unavailable
    case busy
    case conflict
    case sequence
    case integrity
    case unsupportedMedia = "unsupported_media"
    case decodeFailed = "decode_failed"
    case expired
    case bindingChanged = "binding_changed"
    case cleanupFailed = "cleanup_failed"
}

public struct ImageUploadBegin: Sendable, Equatable {
    public let header: WireHeader
    /// Image staging accepts the `claude` harness only.
    public let binding: AttachedBinding
    public let mediaType: ImageMediaType
    public let byteLength: Int
    /// SHA-256 of the image, canonical unpadded base64url.
    public let digest: String

    public init(header: WireHeader, binding: AttachedBinding, mediaType: ImageMediaType, byteLength: Int, digest: String) {
        self.header = header
        self.binding = binding
        self.mediaType = mediaType
        self.byteLength = byteLength
        self.digest = digest
    }
}

public struct ImageUploadAccepted: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String
    public let expiresAt: String

    public init(header: WireHeader, requestId: String, transferId: String, expiresAt: String) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
        self.expiresAt = expiresAt
    }
}

public struct ImageUploadChunk: Sendable, Equatable {
    public let header: WireHeader
    public let transferId: String
    public let seq: Int
    public let data: String

    public init(header: WireHeader, transferId: String, seq: Int, data: String) {
        self.header = header
        self.transferId = transferId
        self.seq = seq
        self.data = data
    }
}

public struct ImageUploadChunkAck: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String
    public let seq: Int
    public let receivedBytes: Int

    public init(header: WireHeader, requestId: String, transferId: String, seq: Int, receivedBytes: Int) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
        self.seq = seq
        self.receivedBytes = receivedBytes
    }
}

public struct ImageUploadComplete: Sendable, Equatable {
    public let header: WireHeader
    public let transferId: String

    public init(header: WireHeader, transferId: String) {
        self.header = header
        self.transferId = transferId
    }
}

/// The staged artifact. `artifactId` differs from `transferId` by rule.
public struct ImageUploadResult: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String
    public let artifactId: String
    public let artifactExpiresAt: String
    public let byteLength: Int
    public let mediaType: ImageMediaType
    public let digest: String

    public init(
        header: WireHeader, requestId: String, transferId: String, artifactId: String, artifactExpiresAt: String,
        byteLength: Int, mediaType: ImageMediaType, digest: String
    ) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
        self.artifactId = artifactId
        self.artifactExpiresAt = artifactExpiresAt
        self.byteLength = byteLength
        self.mediaType = mediaType
        self.digest = digest
    }
}

public struct ImageUploadCancel: Sendable, Equatable {
    public let header: WireHeader
    public let transferId: String

    public init(header: WireHeader, transferId: String) {
        self.header = header
        self.transferId = transferId
    }
}

public struct ImageUploadCancelResult: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let transferId: String

    public init(header: WireHeader, requestId: String, transferId: String) {
        self.header = header
        self.requestId = requestId
        self.transferId = transferId
    }
}

public struct ImageUploadRefused: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let operation: ImageUploadOperation
    public let code: ImageUploadRefusalCode

    public init(header: WireHeader, requestId: String, operation: ImageUploadOperation, code: ImageUploadRefusalCode) {
        self.header = header
        self.requestId = requestId
        self.operation = operation
        self.code = code
    }
}

/// The nine `image_upload_*` messages (ADR 0041). Structural validity only: no authority,
/// transfer, image decode or storage effect.
public enum ImageUploadMessage: Sendable, Equatable {
    case begin(ImageUploadBegin)
    case accepted(ImageUploadAccepted)
    case chunk(ImageUploadChunk)
    case chunkAck(ImageUploadChunkAck)
    case complete(ImageUploadComplete)
    case result(ImageUploadResult)
    case cancel(ImageUploadCancel)
    case cancelResult(ImageUploadCancelResult)
    case refused(ImageUploadRefused)

    public static func decode(_ data: Data) throws -> ImageUploadMessage {
        try decode(json: try WireJSON.parse(data))
    }

    public static func decode(_ text: String) throws -> ImageUploadMessage {
        try decode(Data(text.utf8))
    }

    public static func decode(json: WireJSON) throws -> ImageUploadMessage {
        guard let type = wireType(json) else { throw WireFrameError.invalid("type") }
        func fields(_ response: Bool, _ rest: [String]) throws -> WireFields {
            try WireFields(json, keys: wireKeys(response: response, rest))
        }
        let id16 = 16...16
        let digestBytes = 32...32
        let length = 1...ImageStagingLimits.imageBytes
        switch type {
        case "image_upload_begin":
            let f = try fields(false, ["binding", "mediaType", "byteLength", "digest"])
            return .begin(
                ImageUploadBegin(
                    header: try f.header(), binding: try f.binding("binding", claudeOnly: true),
                    mediaType: try f.oneOf("mediaType", ImageMediaType.self),
                    byteLength: try f.integer("byteLength", in: length),
                    digest: try f.encoded("digest", bytes: digestBytes)))
        case "image_upload_accepted":
            let f = try fields(true, ["transferId", "expiresAt"])
            return .accepted(
                ImageUploadAccepted(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: id16), expiresAt: try f.timestamp("expiresAt")))
        case "image_upload_chunk":
            let f = try fields(false, ["transferId", "seq", "data"])
            return .chunk(
                ImageUploadChunk(
                    header: try f.header(), transferId: try f.encoded("transferId", bytes: id16),
                    seq: try f.integer("seq", in: 0...ImageStagingLimits.maxSequence),
                    data: try f.encoded("data", bytes: 1...ImageStagingLimits.chunkBytes)))
        case "image_upload_chunk_ack":
            let f = try fields(true, ["transferId", "seq", "receivedBytes"])
            return .chunkAck(
                ImageUploadChunkAck(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: id16),
                    seq: try f.integer("seq", in: 0...ImageStagingLimits.maxSequence),
                    receivedBytes: try f.integer("receivedBytes", in: length)))
        case "image_upload_complete":
            let f = try fields(false, ["transferId"])
            return .complete(
                ImageUploadComplete(header: try f.header(), transferId: try f.encoded("transferId", bytes: id16)))
        case "image_upload_result":
            let f = try fields(
                true, ["transferId", "outcome", "artifactId", "artifactExpiresAt", "byteLength", "mediaType", "digest"])
            guard WireGuards.same(try f.string("outcome"), "staged") else { throw WireFrameError.invalid("outcome") }
            let transfer = try f.encoded("transferId", bytes: id16)
            let artifact = try f.encoded("artifactId", bytes: id16)
            guard !WireGuards.same(transfer, artifact) else { throw WireFrameError.invalid("artifactId") }
            return .result(
                ImageUploadResult(
                    header: try f.header(), requestId: try f.uuid4("requestId"), transferId: transfer,
                    artifactId: artifact, artifactExpiresAt: try f.timestamp("artifactExpiresAt"),
                    byteLength: try f.integer("byteLength", in: length),
                    mediaType: try f.oneOf("mediaType", ImageMediaType.self),
                    digest: try f.encoded("digest", bytes: digestBytes)))
        case "image_upload_cancel":
            let f = try fields(false, ["transferId"])
            return .cancel(
                ImageUploadCancel(header: try f.header(), transferId: try f.encoded("transferId", bytes: id16)))
        case "image_upload_cancel_result":
            let f = try fields(true, ["transferId", "outcome"])
            guard WireGuards.same(try f.string("outcome"), "cancelled") else { throw WireFrameError.invalid("outcome") }
            return .cancelResult(
                ImageUploadCancelResult(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    transferId: try f.encoded("transferId", bytes: id16)))
        case "image_upload_refused":
            let f = try fields(true, ["operation", "code"])
            return .refused(
                ImageUploadRefused(
                    header: try f.header(), requestId: try f.uuid4("requestId"),
                    operation: try f.oneOf("operation", ImageUploadOperation.self),
                    code: try f.oneOf("code", ImageUploadRefusalCode.self)))
        default:
            throw WireFrameError.invalid("type")
        }
    }

    public var json: WireJSON {
        func n(_ value: Int) -> WireJSON { .number(Double(value)) }
        switch self {
        case .begin(let m):
            return wireObject(
                type: "image_upload_begin", header: m.header,
                [
                    ("binding", m.binding.json), ("mediaType", .string(m.mediaType.rawValue)),
                    ("byteLength", n(m.byteLength)), ("digest", .string(m.digest)),
                ])
        case .accepted(let m):
            return wireObject(
                type: "image_upload_accepted", header: m.header, requestId: m.requestId,
                [("transferId", .string(m.transferId)), ("expiresAt", .string(m.expiresAt))])
        case .chunk(let m):
            return wireObject(
                type: "image_upload_chunk", header: m.header,
                [("transferId", .string(m.transferId)), ("seq", n(m.seq)), ("data", .string(m.data))])
        case .chunkAck(let m):
            return wireObject(
                type: "image_upload_chunk_ack", header: m.header, requestId: m.requestId,
                [("transferId", .string(m.transferId)), ("seq", n(m.seq)), ("receivedBytes", n(m.receivedBytes))])
        case .complete(let m):
            return wireObject(type: "image_upload_complete", header: m.header, [("transferId", .string(m.transferId))])
        case .result(let m):
            return wireObject(
                type: "image_upload_result", header: m.header, requestId: m.requestId,
                [
                    ("transferId", .string(m.transferId)), ("outcome", .string("staged")),
                    ("artifactId", .string(m.artifactId)), ("artifactExpiresAt", .string(m.artifactExpiresAt)),
                    ("byteLength", n(m.byteLength)), ("mediaType", .string(m.mediaType.rawValue)),
                    ("digest", .string(m.digest)),
                ])
        case .cancel(let m):
            return wireObject(type: "image_upload_cancel", header: m.header, [("transferId", .string(m.transferId))])
        case .cancelResult(let m):
            return wireObject(
                type: "image_upload_cancel_result", header: m.header, requestId: m.requestId,
                [("transferId", .string(m.transferId)), ("outcome", .string("cancelled"))])
        case .refused(let m):
            return wireObject(
                type: "image_upload_refused", header: m.header, requestId: m.requestId,
                [("operation", .string(m.operation.rawValue)), ("code", .string(m.code.rawValue))])
        }
    }

    /// The frame text, or `WireFrameError.invalid("frame")` when this value would not survive the strict decoder.
    public func encodedFrame() throws -> String {
        let text = json.serialized()
        guard let decoded = try? Self.decode(text), decoded == self else { throw WireFrameError.invalid("frame") }
        return text
    }
}

/// Why an image could not be inserted, from `image_insert_result` (ADR 0042).
public enum ImageInsertionRefusalCode: String, Sendable, Equatable, CaseIterable {
    case malformed
    case unavailable
    case busy
    case conflict
    case expired
    case bindingChanged = "binding_changed"
    case promptUp = "prompt_up"
}

/// The outcome and code of an insertion; the pairs are fixed by ADR 0042.
public enum ImageInsertOutcome: Sendable, Equatable {
    /// `outcome: "inserted"`, `code: "none"`.
    case inserted
    /// `outcome: "refused"` with one of the refusal codes.
    case refused(ImageInsertionRefusalCode)
    /// `outcome: "uncertain"`, `code: "delivery_unknown"`: the draft may or may not hold the image.
    case uncertain
}

/// Client to host: add a staged artifact to the attached Claude draft.
public struct ImageInsertRequest: Sendable, Equatable {
    public let header: WireHeader
    public let binding: AttachedBinding
    public let artifactId: String

    public init(header: WireHeader, binding: AttachedBinding, artifactId: String) {
        self.header = header
        self.binding = binding
        self.artifactId = artifactId
    }
}

public struct ImageInsertResult: Sendable, Equatable {
    public let header: WireHeader
    public let requestId: String
    public let outcome: ImageInsertOutcome

    public init(header: WireHeader, requestId: String, outcome: ImageInsertOutcome) {
        self.header = header
        self.requestId = requestId
        self.outcome = outcome
    }
}

/// The two `image_insert_*` messages (ADR 0042).
public enum ImageInsertionMessage: Sendable, Equatable {
    case request(ImageInsertRequest)
    case result(ImageInsertResult)

    public static func decode(_ data: Data) throws -> ImageInsertionMessage {
        try decode(json: try WireJSON.parse(data))
    }

    public static func decode(_ text: String) throws -> ImageInsertionMessage {
        try decode(Data(text.utf8))
    }

    public static func decode(json: WireJSON) throws -> ImageInsertionMessage {
        guard let type = wireType(json) else { throw WireFrameError.invalid("type") }
        switch type {
        case "image_insert_request":
            let f = try WireFields(json, keys: wireKeys(response: false, ["binding", "artifactId"]))
            return .request(
                ImageInsertRequest(
                    header: try f.header(), binding: try f.binding("binding", claudeOnly: true),
                    artifactId: try f.encoded("artifactId", bytes: 16...16)))
        case "image_insert_result":
            let f = try WireFields(json, keys: wireKeys(response: true, ["outcome", "code"]))
            let outcome = try f.string("outcome")
            let code = try f.string("code")
            let parsed: ImageInsertOutcome
            if WireGuards.same(outcome, "inserted"), WireGuards.same(code, "none") {
                parsed = .inserted
            } else if WireGuards.same(outcome, "uncertain"), WireGuards.same(code, "delivery_unknown") {
                parsed = .uncertain
            } else if WireGuards.same(outcome, "refused"),
                let refusal = ImageInsertionRefusalCode.allCases.first(where: { WireGuards.same($0.rawValue, code) })
            {
                parsed = .refused(refusal)
            } else {
                throw WireFrameError.invalid("outcome")
            }
            return .result(ImageInsertResult(header: try f.header(), requestId: try f.uuid4("requestId"), outcome: parsed))
        default:
            throw WireFrameError.invalid("type")
        }
    }

    public var json: WireJSON {
        switch self {
        case .request(let m):
            return wireObject(
                type: "image_insert_request", header: m.header,
                [("binding", m.binding.json), ("artifactId", .string(m.artifactId))])
        case .result(let m):
            let pair: (String, String) =
                switch m.outcome {
                case .inserted: ("inserted", "none")
                case .uncertain: ("uncertain", "delivery_unknown")
                case .refused(let code): ("refused", code.rawValue)
                }
            return wireObject(
                type: "image_insert_result", header: m.header, requestId: m.requestId,
                [("outcome", .string(pair.0)), ("code", .string(pair.1))])
        }
    }

    public func encodedFrame() throws -> String {
        let text = json.serialized()
        guard let decoded = try? Self.decode(text), decoded == self else { throw WireFrameError.invalid("frame") }
        return text
    }
}
