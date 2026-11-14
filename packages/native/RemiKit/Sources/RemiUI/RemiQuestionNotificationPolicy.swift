import Foundation
import RemiKit

/// Selects local question notifications around the daemon's attach-time replay.
/// MachineStore supplies only the first snapshot for an attach-confirmed connection
/// generation. Later snapshots are live reconciliation and do not reset this baseline.
public enum RemiQuestionNotificationPolicy {
    /// Active question identities by machine/session scope plus the last usable snapshot generation.
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

    /// Notification identities produced by one policy transition and its next state.
    public struct Update: Sendable, Equatable {
        public let identitiesToPost: Set<String>
        public let identitiesToRemove: Set<String>
        public let state: State
    }

    /// Applies current questions and only attach-confirmed snapshots returned by
    /// `MachineState.currentQuestionSnapshot(for:)`. Missing snapshots fail closed, and
    /// session scopes absent from the input are retired.
    public static func update(
        state: State,
        currentQuestionIDsBySession: [String: Set<String>],
        snapshotsBySession: [String: MachineQuestionConnectionSnapshot]
    ) -> Update {
        var nextState = state
        var identitiesToPost: Set<String> = []
        var identitiesToRemove: Set<String> = []
        let activeSessions = Set(currentQuestionIDsBySession.keys)
        let sessions = Set(state.knownQuestionIDsBySession.keys)
            .union(state.connectionGenerationBySession.keys)
            .union(activeSessions)

        for session in sessions.sorted() {
            let current = currentQuestionIDsBySession[session] ?? []
            let known = state.knownQuestionIDsBySession[session] ?? []
            let removed = known.subtracting(current)
            identitiesToRemove.formUnion(identities(in: session, questionIDs: removed))

            guard activeSessions.contains(session) else {
                nextState.knownQuestionIDsBySession.removeValue(forKey: session)
                nextState.connectionGenerationBySession.removeValue(forKey: session)
                continue
            }

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
            identitiesToPost.formUnion(identities(in: session, questionIDs: eligible))

            if current.isEmpty {
                nextState.knownQuestionIDsBySession.removeValue(forKey: session)
            } else {
                nextState.knownQuestionIDsBySession[session] = current
            }
            nextState.connectionGenerationBySession[session] = snapshot.generation
        }

        return Update(
            identitiesToPost: identitiesToPost,
            identitiesToRemove: identitiesToRemove,
            state: nextState
        )
    }

    private static func identities(in session: String, questionIDs: Set<String>) -> Set<String> {
        Set(questionIDs.map { "\(session)|\($0)" })
    }
}
