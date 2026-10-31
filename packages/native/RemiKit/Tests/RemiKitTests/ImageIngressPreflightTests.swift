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
        for type in ["image_upload_result", "image_upload_refused", "image_insert_result", "image_upload_future"] {
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
}
