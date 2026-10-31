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

    @Test func imageAtLimitCanReachTheStrictCodec() throws {
        let bytes = frame(#"{"type":"image_upload_result","padding":""#, #""}"#, size: WireJSON.maxFrameBytes)
        #expect(try ImageIngressPreflight.classify(bytes) == .bounded)
    }

    @Test func oversizedImageFamiliesAreRefusedBeforeGeneralDecode() {
        for type in ["image_upload_result", "image_upload_refused", "image_insert_result", "image_upload_future", "image_upload_é"] {
            let bytes = frame(#"{"type":"\#(type)","padding":""#, #""}"#, size: WireJSON.maxFrameBytes + 1)
            #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.classify(bytes) }
        }
    }

    @Test func escapedTypeAfterLargeFieldIsStillRecognized() {
        let bytes = frame(#"{"padding":""#, #"","ty\u0070e":"image_\u0075pload_result"}"#,
                          size: WireJSON.maxFrameBytes + 1)
        #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.classify(bytes) }
    }

    @Test func largeNonImageMessagesRemainAvailable() throws {
        let beforeType = frame(#"{"content":""#, #"","type":"transcript_content"}"#,
                               size: WireJSON.maxFrameBytes + 100)
        let embeddedImageText = frame(#"{"type":"transcript_content","content":""#,
                                      #" \"type\":\"image_upload_result\""}"#,
                                      size: WireJSON.maxFrameBytes + 100)
        for bytes in [beforeType, embeddedImageText] {
            #expect(try ImageIngressPreflight.classify(bytes) == .nonImage)
            #expect((try JSONSerialization.jsonObject(with: bytes)) is [String: Any])
        }
    }

    @Test func nestedTypesAndEscapedDelimitersCannotMisclassifyTheEnvelope() throws {
        let nested = frame(#"{"nested":{"type":"image_upload_result","body":""#,
                           #" \"quoted\" and } ] ,"},"type":"transcript_content"}"#,
                           size: WireJSON.maxFrameBytes + 100)
        #expect(try ImageIngressPreflight.classify(nested) == .nonImage)
        #expect((try JSONSerialization.jsonObject(with: nested)) is [String: Any])
        let hidden = frame(#"{"nested":{"type":"transcript_content","body":""#,
                           #""},"type":"image_insert_result"}"#,
                           size: WireJSON.maxFrameBytes + 100)
        #expect(throws: WireFrameError.oversize) { try ImageIngressPreflight.classify(hidden) }
    }

    @Test func ambiguousLargeEnvelopesFailClosed() {
        let duplicate = frame(#"{"type":"transcript_content","content":""#,
                              #"","type":"image_upload_result"}"#, size: WireJSON.maxFrameBytes + 1)
        let missing = frame(#"{"content":""#, #""}"#, size: WireJSON.maxFrameBytes + 1)
        let malformed = frame(#"{"content":""#, #"","type":"transcript_content""#,
                              size: WireJSON.maxFrameBytes + 1)
        for bytes in [duplicate, missing, malformed] {
            #expect(throws: (any Error).self) { try ImageIngressPreflight.classify(bytes) }
        }
    }

    @Test func genericOutgoingProbeRejectsOnlyImageFamilies() throws {
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
}
