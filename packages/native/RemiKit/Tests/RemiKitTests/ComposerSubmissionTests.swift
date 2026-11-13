import Foundation
import Testing
@testable import RemiUI

@Suite struct ComposerSubmissionTests {
    @Test func trimsPayloadBeforeSending() {
        #expect(RemiComposerSubmission.content(from: "  Review this change\n") == "Review this change")
    }

    @Test(arguments: ["", " ", "\n\t"])
    func rejectsEmptyPayloads(_ draft: String) {
        #expect(RemiComposerSubmission.content(from: draft) == nil)
    }

    @Test func preservesInteriorWhitespace() {
        #expect(RemiComposerSubmission.content(from: "run  both steps") == "run  both steps")
    }

    @Test func unavailableImageEntryExplainsAndCanBeOpenedAgain() {
        var notice = RemiImageAttachmentNotice()
        #expect(!notice.isPresented)
        notice.explain()
        #expect(notice.isPresented)
        #expect(RemiImageAttachmentNotice.message == "Image attachments are not available in this version of the app.")
        notice.dismiss()
        #expect(!notice.isPresented)
        notice.explain()
        #expect(notice.isPresented)
    }

    @Test func imageAttachmentOfferRequiresALiveMainSession() {
        #expect(RemiImageAttachmentNotice.isOffered(for: .liveMain(promptWaiting: false)))
        #expect(!RemiImageAttachmentNotice.isOffered(for: .liveSubagent))
        #expect(!RemiImageAttachmentNotice.isOffered(for: .finished))
        #expect(RemiImageAttachmentNotice.isOffered(isLiveMain: true))
        #expect(!RemiImageAttachmentNotice.isOffered(isLiveMain: false))
    }

    @Test func imageNoticeAndOfferPolicyAreUsedByBothCallSites() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let uiSources = packageRoot.appendingPathComponent("Sources/RemiUI", isDirectory: true)
        let bar = try String(contentsOf: uiSources.appendingPathComponent("SessionInteractionBar.swift"), encoding: .utf8)
        let board = try String(contentsOf: uiSources.appendingPathComponent("BoardTile.swift"), encoding: .utf8)

        #expect(bar.contains("RemiImageAttachmentNotice.isOffered(for: state)"))
        #expect(board.contains("RemiImageAttachmentNotice.isOffered(isLiveMain: session.isLive)"))
        #expect(bar.contains(".help(RemiImageAttachmentNotice.message)"))
        #expect(bar.contains("Text(RemiImageAttachmentNotice.message)"))
    }
}
