import Foundation

/// Selects local question notifications around the daemon's attach-time replay.
/// The first question snapshot on a session connection names the questions that
/// were already pending when the connection attached; later snapshots are live
/// reconciliation and do not reset this baseline.
public enum RemiQuestionNotificationPolicy {
    public struct ConnectionSnapshot: Sendable, Equatable {
        public let generation: UUID
        public let questionIDs: Set<String>

        public init(generation: UUID, questionIDs: Set<String>) {
            self.generation = generation
            self.questionIDs = questionIDs
        }
    }

    public struct State: Sendable, Equatable {
        public var knownQuestionIDsBySession: [String: Set<String>]
        public var connectionGenerationBySession: [String: UUID]

        public init(
            knownQuestionIDsBySession: [String: Set<String>] = [:],
            connectionGenerationBySession: [String: UUID] = [:]
        ) {
            self.knownQuestionIDsBySession = knownQuestionIDsBySession
            self.connectionGenerationBySession = connectionGenerationBySession
        }
    }

    public struct Update: Sendable, Equatable {
        /// Composite machine/session/question identities used by the phone root.
        public let questionIDsToPost: Set<String>
        /// Composite identities whose delivered local notifications should be removed.
        public let questionIDsToRemove: Set<String>
        public let state: State
    }

    /// Applies one view of each session's current questions and its current
    /// connection snapshot. A session without a snapshot is held until its
    /// attach replay has a known boundary.
    public static func update(
        state: State,
        currentQuestionIDsBySession: [String: Set<String>],
        snapshotsBySession: [String: ConnectionSnapshot]
    ) -> Update {
        var nextState = state
        var questionIDsToPost: Set<String> = []
        var questionIDsToRemove: Set<String> = []
        let sessions = Set(state.knownQuestionIDsBySession.keys)
            .union(state.connectionGenerationBySession.keys)
            .union(currentQuestionIDsBySession.keys)
            .union(snapshotsBySession.keys)

        for session in sessions.sorted() {
            let current = currentQuestionIDsBySession[session] ?? []
            let known = state.knownQuestionIDsBySession[session] ?? []
            let removed = known.subtracting(current)
            questionIDsToRemove.formUnion(identities(in: session, questionIDs: removed))

            guard let snapshot = snapshotsBySession[session] else {
                let remainingKnown = known.intersection(current)
                if remainingKnown.isEmpty {
                    nextState.knownQuestionIDsBySession.removeValue(forKey: session)
                } else {
                    nextState.knownQuestionIDsBySession[session] = remainingKnown
                }
                continue
            }

            let isNewConnection = state.connectionGenerationBySession[session] != snapshot.generation
            let newlyPresent = current.subtracting(known)
            let eligible = isNewConnection
                ? newlyPresent.subtracting(snapshot.questionIDs)
                : newlyPresent
            questionIDsToPost.formUnion(identities(in: session, questionIDs: eligible))

            if current.isEmpty {
                nextState.knownQuestionIDsBySession.removeValue(forKey: session)
            } else {
                nextState.knownQuestionIDsBySession[session] = current
            }
            nextState.connectionGenerationBySession[session] = snapshot.generation
        }

        return Update(
            questionIDsToPost: questionIDsToPost,
            questionIDsToRemove: questionIDsToRemove,
            state: nextState
        )
    }

    private static func identities(in session: String, questionIDs: Set<String>) -> Set<String> {
        Set(questionIDs.map { "\(session)|\($0)" })
    }
}
