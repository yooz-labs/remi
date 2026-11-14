import Foundation
import Testing
@testable import RemiUI

@Suite struct RemiQuestionNotificationPolicyTests {
    private struct Case {
        let state: RemiQuestionNotificationPolicy.State
        let current: [String: Set<String>]
        let snapshots: [String: RemiQuestionNotificationPolicy.ConnectionSnapshot]
        let expectedToPost: Set<String>
        let expectedToRemove: Set<String>
        let expectedState: RemiQuestionNotificationPolicy.State
    }

    @Test func literalTransitionTable() {
        let session = "machine|session"
        let firstConnection = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let secondConnection = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
        let thirdConnection = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!
        let questions = Set(["q1", "q2", "q3"])
        let questionsAndNew = Set(["q1", "q2", "q3", "q4"])
        let knownQuestions = RemiQuestionNotificationPolicy.State(
            knownQuestionIDsBySession: [session: questions],
            connectionGenerationBySession: [session: firstConnection]
        )
        let knownQuestionsAndNew = RemiQuestionNotificationPolicy.State(
            knownQuestionIDsBySession: [session: questionsAndNew],
            connectionGenerationBySession: [session: firstConnection]
        )
        let reconnectSnapshotState = RemiQuestionNotificationPolicy.State(
            knownQuestionIDsBySession: [session: questionsAndNew],
            connectionGenerationBySession: [session: thirdConnection]
        )

        let table = [
            // A cold launch's empty first view does not establish a question baseline.
            Case(
                state: .init(),
                current: [session: []],
                snapshots: [:],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: .init()
            ),
            // The first attach snapshot classifies all three replayed IDs as already pending.
            Case(
                state: .init(),
                current: [session: questions],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: knownQuestions
            ),
            // An empty attach snapshot means all three subsequently loaded IDs are new.
            Case(
                state: .init(),
                current: [session: questions],
                snapshots: [session: .init(generation: secondConnection, questionIDs: [])],
                expectedToPost: [
                    "machine|session|q1", "machine|session|q2", "machine|session|q3",
                ],
                expectedToRemove: [],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: questions],
                    connectionGenerationBySession: [session: secondConnection]
                )
            ),
            // Seeing the same IDs a second time does not post them again.
            Case(
                state: knownQuestions,
                current: [session: questions],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: knownQuestions
            ),
            // A single question first appearing while the connection is ready posts once.
            Case(
                state: knownQuestions,
                current: [session: questionsAndNew],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: ["machine|session|q4"],
                expectedToRemove: [],
                expectedState: knownQuestionsAndNew
            ),
            // Re-reading the same set is not a second arrival.
            Case(
                state: knownQuestionsAndNew,
                current: [session: questionsAndNew],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: knownQuestionsAndNew
            ),
            // A removed question clears its delivered local notification.
            Case(
                state: knownQuestionsAndNew,
                current: [session: questions],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: [],
                expectedToRemove: ["machine|session|q4"],
                expectedState: knownQuestions
            ),
            // Re-adding a removed ID is a new arrival in the same connection.
            Case(
                state: knownQuestions,
                current: [session: questionsAndNew],
                snapshots: [session: .init(generation: firstConnection, questionIDs: questions)],
                expectedToPost: ["machine|session|q4"],
                expectedToRemove: [],
                expectedState: knownQuestionsAndNew
            ),
            // A new connection snapshot containing the same IDs suppresses reconnect replay.
            Case(
                state: knownQuestionsAndNew,
                current: [session: questionsAndNew],
                snapshots: [session: .init(generation: thirdConnection, questionIDs: questionsAndNew)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: reconnectSnapshotState
            ),
            // An empty current set removes every notification and keeps the connection ready.
            Case(
                state: reconnectSnapshotState,
                current: [session: []],
                snapshots: [session: .init(generation: thirdConnection, questionIDs: questionsAndNew)],
                expectedToPost: [],
                expectedToRemove: [
                    "machine|session|q1", "machine|session|q2", "machine|session|q3", "machine|session|q4",
                ],
                expectedState: .init(connectionGenerationBySession: [session: thirdConnection])
            ),
        ]

        for row in table {
            let update = RemiQuestionNotificationPolicy.update(
                state: row.state,
                currentQuestionIDsBySession: row.current,
                snapshotsBySession: row.snapshots
            )
            #expect(update.questionIDsToPost == row.expectedToPost)
            #expect(update.questionIDsToRemove == row.expectedToRemove)
            #expect(update.state == row.expectedState)
        }
    }

    @Test func coldLaunchDoesNotTurnAnEmptyFirstListIntoNotifications() {
        let session = "machine|session"
        let generation = UUID(uuidString: "00000000-0000-4000-8000-000000000004")!
        let pending = Set(["q1", "q2", "q3"])

        let emptyFirstList = RemiQuestionNotificationPolicy.update(
            state: .init(),
            currentQuestionIDsBySession: [session: []],
            snapshotsBySession: [:]
        )
        #expect(emptyFirstList.questionIDsToPost.isEmpty)

        let pendingReplay = RemiQuestionNotificationPolicy.update(
            state: emptyFirstList.state,
            currentQuestionIDsBySession: [session: pending],
            snapshotsBySession: [session: .init(generation: generation, questionIDs: pending)]
        )
        #expect(pendingReplay.questionIDsToPost.isEmpty)
        #expect(pendingReplay.state.knownQuestionIDsBySession == [session: pending])
    }

    @Test func phoneRootUsesThePolicyInsteadOfAnInlineBaseline() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let root = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneLiveRootView.swift"),
            encoding: .utf8
        )
        let observer = try sourceSlice(
            root,
            from: ".onChange(of: questionNotificationInput",
            to: ".onChange(of: notificationRouter.destination"
        )

        #expect(observer.contains("RemiQuestionNotificationPolicy.update("))
        #expect(!observer.contains("knownQuestionIDs = newValue"))
        #expect(!observer.contains("notificationBaselineEstablished"))
    }

    @Test func machineStoreKeepsTheFirstSnapshotForEachConnection() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let store = try String(
            contentsOf: nativeRoot.appendingPathComponent("RemiKit/Sources/RemiKit/Store/MachineStore.swift"),
            encoding: .utf8
        )
        let snapshotHandler = try sourceSlice(
            store,
            from: "case .questionSnapshot(let snapshot):",
            to: "case .transcript(let message):"
        )

        #expect(snapshotHandler.contains("questionConnectionSnapshots"))
        #expect(snapshotHandler.contains("previousSnapshot?.generation != generation"))
        #expect(snapshotHandler.contains("questionIDs: Set(snapshot.questionIds)"))

        let connectionHandler = try sourceSlice(
            store,
            from: "case .connected(let sessionID):",
            to: "case .awaitingLocalApproval(let fingerprint):"
        )
        #expect(connectionHandler.contains("questionConnectionGenerations[sessionID] = generation"))
    }

    private func sourceSlice(_ source: String, from startMarker: String, to endMarker: String) throws -> String {
        let fullRange = source.startIndex..<source.endIndex
        let startRange = try #require(source.range(of: startMarker, range: fullRange))
        let endRange = try #require(source.range(of: endMarker, range: startRange.upperBound..<source.endIndex))
        return String(source[startRange.lowerBound..<endRange.lowerBound])
    }
}
