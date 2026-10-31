import Foundation
import Testing
@testable import RemiKit

struct LocalNoticeQuestionAuthorityTests {
    @Test func replayMustBeConfirmedByTheSameGenerationSnapshot() throws {
        let session = LocalNoticeQuestionAuthority.Session(owner: UUID(), sessionID: "one")
        let first = UUID(), second = UUID()
        var authority = LocalNoticeQuestionAuthority()
        try authority.begin(session, generation: first)
        try authority.question("replayed", in: session, generation: first)
        #expect(authority.awaitingSnapshot(session, generation: first))
        let emptyValue = try authority.snapshot([], in: session, generation: first)
        let empty = try #require(emptyValue)
        #expect(empty.schedule.isEmpty); #expect(empty.resolved.isEmpty)
        #expect(!authority.awaitingSnapshot(session, generation: first))
        try authority.question("live", in: session, generation: first)
        #expect(authority.awaitingSnapshot(session, generation: first))
        let liveValue = try authority.snapshot(["live"], in: session, generation: first)
        let live = try #require(liveValue)
        #expect(live.schedule == ["live"])
        try authority.question("live", in: session, generation: first)
        let duplicate = try authority.snapshot(["live"], in: session, generation: first)
        #expect(duplicate?.schedule.isEmpty == true)
        authority.suspend(session, generation: first)
        try authority.begin(session, generation: second)
        try authority.question("live", in: session, generation: first)
        let stale = try authority.snapshot([], in: session, generation: first)
        #expect(stale == nil)
        try authority.question("live", in: session, generation: second)
        let reaffirmed = try authority.snapshot(["live"], in: session, generation: second)
        #expect(reaffirmed?.schedule == ["live"])
    }

    @Test func resolutionAndNewIncarnationAndOtherSessionsRemainDistinct() throws {
        let owner = UUID(), a = LocalNoticeQuestionAuthority.Session(owner: owner, sessionID: "a")
        let b = LocalNoticeQuestionAuthority.Session(owner: owner, sessionID: "b"), generation = UUID()
        var authority = LocalNoticeQuestionAuthority()
        try authority.begin(a, generation: generation); try authority.begin(b, generation: generation)
        try authority.question("q", in: a, generation: generation); try authority.question("q", in: b, generation: generation)
        let firstA = try authority.snapshot(["q"], in: a, generation: generation)
        let firstB = try authority.snapshot(["q"], in: b, generation: generation)
        #expect(firstA?.schedule == ["q"]); #expect(firstB?.schedule == ["q"])
        let wasResolved = try authority.resolved("q", in: a, generation: generation)
        #expect(wasResolved)
        try authority.question("q", in: a, generation: generation)
        let newA = try authority.snapshot(["q"], in: a, generation: generation)
        let unchangedB = try authority.snapshot(["q"], in: b, generation: generation)
        let emptyA = try authority.snapshot([], in: a, generation: generation)
        #expect(newA?.schedule == ["q"]); #expect(unchangedB?.resolved.isEmpty == true)
        #expect(emptyA?.resolved == ["q"])
    }

    @Test func aSnapshotWithoutQuestionContentDoesNotInventAnAlert() throws {
        let session = LocalNoticeQuestionAuthority.Session(owner: UUID(), sessionID: "synthetic")
        let generation = UUID()
        var authority = LocalNoticeQuestionAuthority()
        try authority.begin(session, generation: generation)
        let missing = try authority.snapshot(["q"], in: session, generation: generation)
        #expect(missing?.schedule.isEmpty == true)
        try authority.question("q", in: session, generation: generation)
        let supplied = try authority.snapshot(["q"], in: session, generation: generation)
        #expect(supplied?.schedule == ["q"])
    }
}
