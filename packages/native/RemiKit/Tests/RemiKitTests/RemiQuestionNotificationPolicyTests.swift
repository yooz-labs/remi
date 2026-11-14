import Foundation
import Testing
@testable import RemiKit
@testable import RemiUI

@Suite struct RemiQuestionNotificationPolicyTests {
    private struct Case {
        let name: String
        let state: RemiQuestionNotificationPolicy.State
        let current: [String: Set<String>]
        let snapshots: [String: MachineQuestionConnectionSnapshot]
        let expectedToPost: Set<String>
        let expectedToRemove: Set<String>
        let expectedState: RemiQuestionNotificationPolicy.State
    }

    @Test func literalTransitionTable() {
        let session = "machine|session"
        let anotherMachineSession = "another-machine|session"
        let firstConnection = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let secondConnection = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
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

        let table = [
            Case(
                name: "empty first list does not establish a baseline",
                state: .init(),
                current: [session: []],
                snapshots: [:],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: .init()
            ),
            Case(
                name: "questions without an attach snapshot stay held and unknown",
                state: .init(),
                current: [session: questions],
                snapshots: [:],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: .init()
            ),
            Case(
                name: "attach snapshot suppresses the held pending batch",
                state: .init(),
                current: [session: questions],
                snapshots: [session: snapshot(endpoint: "child", generation: firstConnection, questions: questions)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: knownQuestions
            ),
            Case(
                name: "empty attach snapshot allows all three later questions",
                state: .init(),
                current: [session: questions],
                snapshots: [session: snapshot(endpoint: "child", generation: firstConnection, questions: [])],
                expectedToPost: [
                    "machine|session|q1", "machine|session|q2", "machine|session|q3",
                ],
                expectedToRemove: [],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: questions],
                    connectionGenerationBySession: [session: firstConnection]
                )
            ),
            Case(
                name: "one question after the snapshot posts once",
                state: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1", "q2"]],
                    connectionGenerationBySession: [session: firstConnection]
                ),
                current: [session: ["q1", "q2", "q3"]],
                snapshots: [session: snapshot(endpoint: "child", generation: firstConnection, questions: ["q1", "q2"])],
                expectedToPost: ["machine|session|q3"],
                expectedToRemove: [],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1", "q2", "q3"]],
                    connectionGenerationBySession: [session: firstConnection]
                )
            ),
            Case(
                name: "a repeated question set does not post twice",
                state: knownQuestionsAndNew,
                current: [session: questionsAndNew],
                snapshots: [session: snapshot(endpoint: "child", generation: firstConnection, questions: questions)],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: knownQuestionsAndNew
            ),
            Case(
                name: "reconnect snapshot suppresses an ID not known before reconnect",
                state: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1"]],
                    connectionGenerationBySession: [session: firstConnection]
                ),
                current: [session: ["q1", "q2"]],
                snapshots: [session: snapshot(endpoint: "child", generation: secondConnection, questions: ["q1", "q2"])],
                expectedToPost: [],
                expectedToRemove: [],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1", "q2"]],
                    connectionGenerationBySession: [session: secondConnection]
                )
            ),
            Case(
                name: "reconnect removes missing IDs and posts an ID outside its snapshot",
                state: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1", "q2"]],
                    connectionGenerationBySession: [session: firstConnection]
                ),
                current: [session: ["q2", "q3"]],
                snapshots: [session: snapshot(endpoint: "child", generation: secondConnection, questions: ["q2"])],
                expectedToPost: ["machine|session|q3"],
                expectedToRemove: ["machine|session|q1"],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q2", "q3"]],
                    connectionGenerationBySession: [session: secondConnection]
                )
            ),
            Case(
                name: "same session and question IDs stay separate by machine",
                state: .init(),
                current: [session: ["same"], anotherMachineSession: ["same"]],
                snapshots: [
                    session: snapshot(endpoint: "child-a", generation: firstConnection, questions: ["same"]),
                    anotherMachineSession: snapshot(endpoint: "child-b", generation: secondConnection, questions: []),
                ],
                expectedToPost: ["another-machine|session|same"],
                expectedToRemove: [],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["same"], anotherMachineSession: ["same"]],
                    connectionGenerationBySession: [session: firstConnection, anotherMachineSession: secondConnection]
                )
            ),
            Case(
                name: "vanished session clears its known IDs and generation",
                state: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [session: ["q1"], anotherMachineSession: ["q2"]],
                    connectionGenerationBySession: [session: firstConnection, anotherMachineSession: secondConnection]
                ),
                current: [anotherMachineSession: ["q2"]],
                snapshots: [anotherMachineSession: snapshot(endpoint: "child-b", generation: secondConnection, questions: ["q2"])],
                expectedToPost: [],
                expectedToRemove: ["machine|session|q1"],
                expectedState: RemiQuestionNotificationPolicy.State(
                    knownQuestionIDsBySession: [anotherMachineSession: ["q2"]],
                    connectionGenerationBySession: [anotherMachineSession: secondConnection]
                )
            ),
            Case(
                name: "empty active session removes every notification",
                state: knownQuestions,
                current: [session: []],
                snapshots: [session: snapshot(endpoint: "child", generation: firstConnection, questions: questions)],
                expectedToPost: [],
                expectedToRemove: [
                    "machine|session|q1", "machine|session|q2", "machine|session|q3",
                ],
                expectedState: RemiQuestionNotificationPolicy.State(
                    connectionGenerationBySession: [session: firstConnection]
                )
            ),
        ]

        for row in table {
            let update = RemiQuestionNotificationPolicy.update(
                state: row.state,
                currentQuestionIDsBySession: row.current,
                snapshotsBySession: row.snapshots
            )
            #expect(update.identitiesToPost == row.expectedToPost, "\(row.name)")
            #expect(update.identitiesToRemove == row.expectedToRemove, "\(row.name)")
            #expect(update.state == row.expectedState, "\(row.name)")
        }
    }

    @Test func removedQuestionCanBeReaddedUsingEachReturnedState() {
        let session = "machine|session"
        let generation = UUID(uuidString: "00000000-0000-4000-8000-000000000010")!
        let snapshots = [session: snapshot(endpoint: "child", generation: generation, questions: [])]

        let added = RemiQuestionNotificationPolicy.update(
            state: .init(),
            currentQuestionIDsBySession: [session: ["reused"]],
            snapshotsBySession: snapshots
        )
        #expect(added.identitiesToPost == ["machine|session|reused"], "first arrival posts")

        let removed = RemiQuestionNotificationPolicy.update(
            state: added.state,
            currentQuestionIDsBySession: [session: []],
            snapshotsBySession: snapshots
        )
        #expect(removed.identitiesToRemove == ["machine|session|reused"], "removal clears its notification")

        let readded = RemiQuestionNotificationPolicy.update(
            state: removed.state,
            currentQuestionIDsBySession: [session: ["reused"]],
            snapshotsBySession: snapshots
        )
        #expect(readded.identitiesToPost == ["machine|session|reused"], "re-add is a new arrival")
    }

    @Test func heldQuestionsRemainUnknownUntilAnAttachSnapshotArrives() {
        let session = "machine|session"
        let generation = UUID(uuidString: "00000000-0000-4000-8000-000000000011")!
        let pending = Set(["q1", "q2", "q3"])
        let questions = RemiQuestionNotificationPolicy.update(
            state: .init(),
            currentQuestionIDsBySession: [session: pending],
            snapshotsBySession: [:]
        )
        #expect(questions.identitiesToPost.isEmpty, "questions without a snapshot stay held")
        #expect(questions.state.knownQuestionIDsBySession.isEmpty, "held questions do not become known")

        let snapshot = RemiQuestionNotificationPolicy.update(
            state: questions.state,
            currentQuestionIDsBySession: [session: pending],
            snapshotsBySession: [session: snapshot(endpoint: "child", generation: generation, questions: pending)]
        )
        #expect(snapshot.identitiesToPost.isEmpty, "the attach snapshot suppresses the pending batch")
        #expect(snapshot.state.knownQuestionIDsBySession == [session: pending], "the snapshot establishes known IDs")
    }

    @Test func compositeIdentityMatchesTheQuestionCardIdentity() {
        #expect(
            RemiQuestionCardModel.identity(machineID: "machine", sessionID: "session", questionID: "q1")
                == "machine|session|q1",
            "notification identities must keep the view's composite format"
        )
    }

    @Test func phoneRootPassesOnlyCurrentStoreSnapshotsAndUsesPolicyIdentities() throws {
        let nativeRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let root = try String(
            contentsOf: nativeRoot.appendingPathComponent("iPhone/PhoneLiveRootView.swift"),
            encoding: .utf8
        )
        let input = try sourceSlice(
            root,
            from: "private var questionNotificationInput:",
            to: "private func questionNotificationSession"
        )
        let observer = try sourceSlice(
            root,
            from: ".onChange(of: questionNotificationInput",
            to: ".onChange(of: notificationRouter.destination"
        )

        #expect(input.contains("machine.currentQuestionSnapshot(for: sessionID)"))
        #expect(observer.contains("RemiQuestionNotificationPolicy.update("))
        #expect(observer.contains("update.identitiesToPost"))
        #expect(observer.contains("update.identitiesToRemove"))
        #expect(observer.contains("questionNotificationPolicyState = update.state"))
        #expect(!observer.contains("notificationBaselineEstablished"))
    }

    private func snapshot(
        endpoint: String,
        generation: UUID,
        questions: Set<String>
    ) -> MachineQuestionConnectionSnapshot {
        MachineQuestionConnectionSnapshot(endpointID: endpoint, generation: generation, questionIDs: questions)
    }

    private func sourceSlice(_ source: String, from startMarker: String, to endMarker: String) throws -> String {
        let fullRange = source.startIndex..<source.endIndex
        let startRange = try #require(source.range(of: startMarker, range: fullRange))
        let endRange = try #require(source.range(of: endMarker, range: startRange.upperBound..<source.endIndex))
        return String(source[startRange.lowerBound..<endRange.lowerBound])
    }
}
