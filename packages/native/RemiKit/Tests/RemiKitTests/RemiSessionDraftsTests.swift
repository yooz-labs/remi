import Testing
@testable import RemiUI

@Suite struct RemiSessionDraftsTests {
    private func key(_ machine: String, _ session: String) -> RemiSessionKey {
        RemiSessionKey(machineID: machine, sessionID: session)
    }

    @Test func sameSessionIDOnTwoMachinesKeepsSeparateDrafts() {
        let drafts = RemiSessionDrafts()
            .setting("one", for: key("A", "s"))
            .setting("two", for: key("B", "s"))
        #expect(drafts.draft(for: key("A", "s")) == "one")
        #expect(drafts.draft(for: key("B", "s")) == "two")
        #expect(drafts.draft(for: key("A", "other")) == "")
    }

    @Test func emptyTextRemovesTheDraft() {
        let drafts = RemiSessionDrafts().setting("hello", for: key("A", "s"))
        #expect(drafts.setting("", for: key("A", "s")) == RemiSessionDrafts())
    }

    @Test func roundTripsThroughStorage() {
        let drafts = RemiSessionDrafts()
            .setting("quote \" and \n newline é", for: key("A", "s"))
            .setting("second", for: key("B", "t"))
        let restored = RemiSessionDrafts(storageValue: drafts.storageValue)
        #expect(restored == drafts)
        #expect(RemiSessionDrafts().storageValue == "")
    }

    @Test func unreadableStorageIsNoDrafts() {
        #expect(RemiSessionDrafts(storageValue: "not json") == RemiSessionDrafts())
        #expect(RemiSessionDrafts(storageValue: "") == RemiSessionDrafts())
    }

    @Test func oldestDraftsFallOffPastTheLimit() {
        var drafts = RemiSessionDrafts()
        for index in 0..<(RemiSessionDrafts.maximumDrafts + 3) {
            drafts = drafts.setting("draft \(index)", for: key("A", "s\(index)"))
        }
        #expect(drafts.draft(for: key("A", "s0")) == "")
        #expect(drafts.draft(for: key("A", "s2")) == "")
        #expect(drafts.draft(for: key("A", "s3")) == "draft 3")
        #expect(drafts.draft(for: key("A", "s\(RemiSessionDrafts.maximumDrafts + 2)")) != "")
    }

    @Test func editingMakesADraftTheNewest() {
        var drafts = RemiSessionDrafts()
        for index in 0..<RemiSessionDrafts.maximumDrafts {
            drafts = drafts.setting("d", for: key("A", "s\(index)"))
        }
        drafts = drafts.setting("edited", for: key("A", "s0"))
        drafts = drafts.setting("new", for: key("A", "extra"))
        #expect(drafts.draft(for: key("A", "s0")) == "edited")
        #expect(drafts.draft(for: key("A", "s1")) == "")
    }

    @Test func longTextIsCut() {
        let long = String(repeating: "x", count: RemiSessionDrafts.maximumCharacters + 50)
        let drafts = RemiSessionDrafts().setting(long, for: key("A", "s"))
        #expect(drafts.draft(for: key("A", "s")).count == RemiSessionDrafts.maximumCharacters)
        let restored = RemiSessionDrafts(storageValue: RemiSessionDrafts().setting("y", for: key("A", "s")).storageValue)
        #expect(restored.draft(for: key("A", "s")) == "y")
    }
}
