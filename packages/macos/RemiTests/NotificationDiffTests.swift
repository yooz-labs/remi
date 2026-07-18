//
//  NotificationDiffTests.swift
//  RemiTests
//
//  Tests for the pure new-vs-seen diff behind native notifications (#786):
//  no UNUserNotificationCenter involved, just NotificationDiff.diff().
//

import XCTest


final class NotificationDiffTests: XCTestCase {
    private func notice(_ id: String, session: String = "host:project/main", label: String = "Permission: Bash")
        -> PendingQuestionNotice
    {
        PendingQuestionNotice(id: id, sessionName: session, label: label)
    }

    func testEmptyPreviousAndCurrentIsANoOp() {
        let result = NotificationDiff.diff(previousIds: [], current: [])
        XCTAssertEqual(result.newQuestions, [])
        XCTAssertEqual(result.resolvedIds, [])
    }

    func testFirstSeenQuestionsAreAllNew() {
        let result = NotificationDiff.diff(previousIds: [], current: [notice("q1"), notice("q2")])
        XCTAssertEqual(result.newQuestions, [notice("q1"), notice("q2")])
        XCTAssertEqual(result.resolvedIds, [])
    }

    func testAQuestionThatDisappearsIsResolved() {
        let result = NotificationDiff.diff(previousIds: ["q1"], current: [])
        XCTAssertEqual(result.newQuestions, [])
        XCTAssertEqual(result.resolvedIds, ["q1"])
    }

    func testAStillPendingQuestionIsNeitherNewNorResolved() {
        let result = NotificationDiff.diff(previousIds: ["q1"], current: [notice("q1")])
        XCTAssertEqual(result.newQuestions, [])
        XCTAssertEqual(result.resolvedIds, [])
    }

    func testOneResolvedAndOneNewInTheSameBeat() {
        // The exact case a naive count-only comparison would miss: same
        // SIZE (1 in, 1 out) but a genuinely different question.
        let result = NotificationDiff.diff(previousIds: ["q-old"], current: [notice("q-new")])
        XCTAssertEqual(result.newQuestions, [notice("q-new")])
        XCTAssertEqual(result.resolvedIds, ["q-old"])
    }

    func testMixedSetOfNewStillPendingAndResolved() {
        let result = NotificationDiff.diff(
            previousIds: ["q1", "q2", "q3"],
            current: [notice("q2"), notice("q4")])
        XCTAssertEqual(result.newQuestions, [notice("q4")])
        XCTAssertEqual(result.resolvedIds, ["q1", "q3"])
    }

    func testResolvedIdsAreSortedForDeterministicOrdering() {
        let result = NotificationDiff.diff(previousIds: ["qc", "qa", "qb"], current: [])
        XCTAssertEqual(result.resolvedIds, ["qa", "qb", "qc"])
    }

    func testReconnectReplayOfAnAlreadySeenQuestionDoesNotReAlert() {
        // A reconnect/re-broadcast of the SAME still-pending question must
        // not re-notify -- exactly what keying by id (not counting) buys.
        let previous: Set<String> = ["q1"]
        let result = NotificationDiff.diff(previousIds: previous, current: [notice("q1")])
        XCTAssertTrue(result.newQuestions.isEmpty)
    }

    func testEquatableNoticeCarriesSessionAndLabel() {
        let a = notice("q1", session: "host:a/main", label: "Permission: Bash")
        let b = notice("q1", session: "host:a/main", label: "Permission: Bash")
        let c = notice("q1", session: "host:b/main", label: "Permission: Bash")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }
}
