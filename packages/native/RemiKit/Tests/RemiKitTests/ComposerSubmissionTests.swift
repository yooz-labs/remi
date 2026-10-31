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
        #expect(RemiImageAttachmentNotice.message.contains("not available"))
        notice.dismiss()
        #expect(!notice.isPresented)
        notice.explain()
        #expect(notice.isPresented)
    }
}
