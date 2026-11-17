import Foundation
import Testing
@testable import RemiKit

/// The pre-envelope guard must recognize oversized image families without decoding them as
/// general JSON or rejecting a valid, large transcript on the same connection (#1313).
@Suite struct ImageIngressPreflightTests {
    private func frame(_ prefix: String, _ suffix: String, size: Int) -> Data {
        let padding = size - prefix.utf8.count - suffix.utf8.count
        precondition(padding >= 0)
        return Data((prefix + String(repeating: "x", count: padding) + suffix).utf8)
    }

    @Test func imageAtLimitPassesPreflight() throws {
        let bytes = frame(#"{"type":"image_upload_result","padding":""#, #""}"#, size: WireJSON.maxFrameBytes)
        try ImageIngressPreflight.refuseOversizedImage(bytes)
    }

    @Test func preflightRefusesOversizedImageFamilies() {
        for type in ["image_upload_result", "image_upload_refused", "image_insert_result", "image_upload_future", "image_upload_é"] {
            let bytes = frame(#"{"type":"\#(type)","padding":""#, #""}"#, size: WireJSON.maxFrameBytes + 1)
            #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.refuseOversizedImage(bytes) }
        }
    }

    @Test func escapedTypeAfterLargeFieldIsStillRecognized() {
        let bytes = frame(#"{"padding":""#, #"","ty\u0070e":"image_\u0075pload_result"}"#,
                          size: WireJSON.maxFrameBytes + 1)
        #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.refuseOversizedImage(bytes) }
    }

    @Test func preflightAllowsLargeNonImageMessages() throws {
        let beforeType = frame(#"{"content":""#, #"","type":"transcript_content"}"#,
                               size: WireJSON.maxFrameBytes + 100)
        let embeddedImageText = frame(#"{"type":"transcript_content","content":""#,
                                      #" \"type\":\"image_upload_result\""}"#,
                                      size: WireJSON.maxFrameBytes + 100)
        for bytes in [beforeType, embeddedImageText] {
            try ImageIngressPreflight.refuseOversizedImage(bytes)
            #expect((try JSONSerialization.jsonObject(with: bytes)) is [String: Any])
        }
    }

    @Test func nestedTypesAndEscapedDelimitersCannotMisclassifyTheEnvelope() throws {
        let nested = frame(#"{"nested":{"type":"image_upload_result","body":""#,
                           #" \"quoted\" and } ] ,"},"type":"transcript_content"}"#,
                           size: WireJSON.maxFrameBytes + 100)
        try ImageIngressPreflight.refuseOversizedImage(nested)
        #expect((try JSONSerialization.jsonObject(with: nested)) is [String: Any])
        let hidden = frame(#"{"nested":{"type":"transcript_content","body":""#,
                           #""},"type":"image_insert_result"}"#,
                           size: WireJSON.maxFrameBytes + 100)
        #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.refuseOversizedImage(hidden) }
    }

    @Test func ambiguousLargeEnvelopesFailClosed() {
        let duplicate = frame(#"{"type":"transcript_content","content":""#,
                              #"","type":"image_upload_result"}"#, size: WireJSON.maxFrameBytes + 1)
        let missing = frame(#"{"content":""#, #""}"#, size: WireJSON.maxFrameBytes + 1)
        let malformed = frame(#"{"content":""#, #"","type":"transcript_content""#,
                              size: WireJSON.maxFrameBytes + 1)
        for bytes in [duplicate, missing, malformed] {
            #expect(throws: (any Error).self) { try ImageIngressPreflight.refuseOversizedImage(bytes) }
        }
    }

    @Test func genericOutgoingProbeIdentifiesImagesAndRejectsAmbiguousTypes() throws {
        let image = Data(#"{"nested":{"type":"chat"},"ty\u0070e":"image_\u0075pload_begin"}"#.utf8)
        let insertion = Data(#"{"type":"image_insert_request","content":"safe"}"#.utf8)
        let unrelated = Data(#"{"nested":{"type":"image_upload_begin"},"type":"user_input","content":"quoted } ] ,"}"#.utf8)
        let missing = Data(#"{"content":"no type"}"#.utf8)
        let scalar = Data(#"["image_upload_begin"]"#.utf8)
        #expect(try ImageIngressPreflight.outgoingIsImage(image))
        #expect(try ImageIngressPreflight.outgoingIsImage(insertion))
        for bytes in [unrelated, missing, scalar] {
            let isImage = try ImageIngressPreflight.outgoingIsImage(bytes)
            #expect(!isImage)
        }
        let duplicate = Data(#"{"type":"chat","type":"image_upload_begin"}"#.utf8)
        #expect(throws: (any Error).self) { try ImageIngressPreflight.outgoingIsImage(duplicate) }
        let nested = String(repeating: "[", count: 600) + "0" + String(repeating: "]", count: 600)
        let deep = Data("{\"content\":\(nested),\"type\":\"user_input\"}".utf8)
        let deepIsImage = try ImageIngressPreflight.outgoingIsImage(deep)
        #expect(!deepIsImage)
    }

    @Test func genericProbeAllowsLargeOrdinaryChat() throws {
        let message = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z",
            sessionId: "108a8a9e-912e-4d52-9fdd-913c16654f5c",
            content: String(repeating: "x", count: 1_000_000) + " image_upload_begin")
        let bytes = try JSONEncoder().encode(message)
        let isImage = try ImageIngressPreflight.outgoingIsImage(bytes)
        #expect(!isImage)
    }

    @Test func everyEncodedImageMessageUsesAnImageFamilyPrefix() throws {
        func header() -> WireHeader {
            WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-11-13T20:00:00.000Z",
                       sessionId: "108a8a9e-912e-4d52-9fdd-913c16654f5c")
        }
        func encoded(_ bytes: Data) -> String {
            bytes.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }

        let transferId = encoded(Data(repeating: 0x11, count: 16))
        let artifactId = encoded(Data(repeating: 0x22, count: 16))
        let digest = encoded(Data(repeating: 0x33, count: 32))
        let binding = AttachedBinding(harness: .claude, harnessSessionId: "09a9e195-b1af-4bd5-b9bf-e64855b16d36")
        let expiresAt = "2026-11-13T21:00:00.000Z"
        let uploadMessages: [ImageUploadMessage] = [
            .begin(ImageUploadBegin(header: header(), binding: binding, mediaType: .png, byteLength: 1, digest: digest)),
            .accepted(ImageUploadAccepted(header: header(), requestId: UUID().uuidString.lowercased(),
                transferId: transferId, expiresAt: expiresAt)),
            .chunk(ImageUploadChunk(header: header(), transferId: transferId, seq: 0, data: encoded(Data([0x44])))),
            .chunkAck(ImageUploadChunkAck(header: header(), requestId: UUID().uuidString.lowercased(),
                transferId: transferId, seq: 0, receivedBytes: 1)),
            .complete(ImageUploadComplete(header: header(), transferId: transferId)),
            .result(ImageUploadResult(header: header(), requestId: UUID().uuidString.lowercased(),
                transferId: transferId, artifactId: artifactId, artifactExpiresAt: expiresAt,
                byteLength: 1, mediaType: .png, digest: digest)),
            .cancel(ImageUploadCancel(header: header(), transferId: transferId)),
            .cancelResult(ImageUploadCancelResult(header: header(), requestId: UUID().uuidString.lowercased(),
                transferId: transferId)),
            .refused(ImageUploadRefused(header: header(), requestId: UUID().uuidString.lowercased(),
                operation: .begin, code: .unavailable)),
        ]
        let insertMessages: [ImageInsertionMessage] = [
            .request(ImageInsertRequest(header: header(), binding: binding, artifactId: artifactId)),
            .result(ImageInsertResult(header: header(), requestId: UUID().uuidString.lowercased(), outcome: .inserted)),
        ]
        let frames = try uploadMessages.map { try $0.encodedFrame() } + insertMessages.map { try $0.encodedFrame() }
        let types = try frames.map { frame -> String in
            let object = try #require(JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
            return try #require(object["type"] as? String)
        }

        #expect(ImageUploadOperation.allCases.allSatisfy { ImageIngressPreflight.isImageType($0.rawValue) })
        #expect(types.count == 11)
        #expect(types.allSatisfy { ImageIngressPreflight.isImageType($0) })
    }

    @Test func duplicateTopLevelTypeCannotHideAnImageType() {
        let bytes = Data(#"{"type":"user_input","type":"image_upload_begin"}"#.utf8)
        #expect(throws: WireFrameError.malformedJSON) { try WireJSON.parse(bytes) }
        #expect(throws: WireFrameError.malformedJSON) { try ImageIngressPreflight.outgoingIsImage(bytes) }
    }
}
