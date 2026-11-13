import Foundation
import Testing

@testable import RemiKit
@testable import RemiUI

#if DEBUG
struct RemiFileDownloadPreviewTests {
    @Test func previewFlowsReachTheStagesTheyClaim() {
        typealias P = RemiFileDownloadPreviewFlows
        #expect(P.flow(upTo: 0).status == .requesting)
        guard case .receiving(let received, let total, let name) = P.flow(upTo: 2).status else {
            Issue.record("not receiving")
            return
        }
        #expect(received == FileFetchLimits.chunkBytes && total == P.payload.count && name == "notes.txt")
        let done = P.flow(upTo: 3)
        #expect(done.status == .verified(fileName: "notes.txt", byteCount: P.payload.count, hostSettled: true))
        #expect(done.verifiedFile?.data == P.payload)
        #expect(P.refused().status == .failed(FileDownloadFlow.text(for: .unavailable)))
    }
}
#endif
