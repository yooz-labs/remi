import Foundation

/// Tracks only exact Store-supplied owner/session/connection generations. A question event may
/// come from replay; it is not notification authority until a later snapshot contains its ID.
struct LocalNoticeQuestionAuthority {
    struct Session: Hashable {
        let owner: UUID
        let sessionID: String
    }
    struct SnapshotResult: Equatable {
        let schedule: Set<String>
        let resolved: Set<String>
    }
    private struct State {
        var generation: UUID?
        var confirmed: Set<String> = []
        var staged: Set<String> = []
        var scheduled: Set<String> = []
        var receivedSnapshot = false
    }
    private var sessions: [Session: State] = [:]
    private static let maximumQuestions = 1_024
    private static let maximumEntries = 4_096

    /// A different connection generation requires a fresh snapshot. Previously confirmed IDs
    /// remain known for exact later absence, but lose current-generation scheduling authority.
    mutating func begin(_ session: Session, generation: UUID) throws {
        try validate(session.sessionID)
        if sessions[session] == nil && sessions.count >= Self.maximumQuestions { throw LocalNoticeError.capacity }
        var state = sessions[session] ?? State()
        guard state.generation != generation else { return }
        state.generation = generation; state.staged.removeAll(); state.scheduled.removeAll(); state.receivedSnapshot = false
        sessions[session] = state
    }

    mutating func suspend(_ session: Session, generation: UUID) {
        guard var state = sessions[session], state.generation == generation else { return }
        state.generation = nil; state.staged.removeAll(); state.scheduled.removeAll()
        sessions[session] = state
    }

    /// The UI may surface a bounded wait warning for older peers that never send snapshots.
    func awaitingSnapshot(_ session: Session, generation: UUID) -> Bool {
        guard let state = sessions[session], state.generation == generation else { return false }
        return !state.receivedSnapshot || !state.staged.subtracting(state.scheduled).isEmpty
    }

    mutating func question(_ id: String, in session: Session, generation: UUID) throws {
        guard var state = sessions[session], state.generation == generation else { return }
        try validate(id)
        guard state.staged.contains(id) || state.staged.count < Self.maximumQuestions else { throw LocalNoticeError.capacity }
        state.staged.insert(id)
        try checkCapacity(replacing: session, with: state)
        sessions[session] = state
    }

    mutating func snapshot(_ ids: [String], in session: Session, generation: UUID) throws -> SnapshotResult? {
        guard var state = sessions[session], state.generation == generation else { return nil }
        guard ids.count <= Self.maximumQuestions else { throw LocalNoticeError.capacity }
        for id in ids { try validate(id) }
        let present = Set(ids)
        let result = SnapshotResult(schedule: state.staged.intersection(present).subtracting(state.scheduled),
                                    resolved: state.confirmed.subtracting(present))
        state.scheduled.formIntersection(present)
        state.scheduled.formUnion(result.schedule)
        state.confirmed = present; state.staged.removeAll(); state.receivedSnapshot = true
        try checkCapacity(replacing: session, with: state)
        sessions[session] = state
        return result
    }

    /// This event itself is authoritative only after the Store verifies origin/generation.
    mutating func resolved(_ id: String, in session: Session, generation: UUID) throws -> Bool {
        guard var state = sessions[session], state.generation == generation else { return false }
        try validate(id)
        let existed = state.confirmed.remove(id) != nil || state.staged.contains(id) || state.scheduled.contains(id)
        state.staged.remove(id); state.scheduled.remove(id); sessions[session] = state
        return existed
    }

    private func validate(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 512 else { throw LocalNoticeError.invalid }
    }

    private func checkCapacity(replacing session: Session, with value: State) throws {
        var total = sessions.count + value.confirmed.count + value.staged.count + value.scheduled.count
        for (key, state) in sessions where key != session {
            total += state.confirmed.count + state.staged.count + state.scheduled.count
            guard total <= Self.maximumEntries else { throw LocalNoticeError.capacity }
        }
        guard total <= Self.maximumEntries else { throw LocalNoticeError.capacity }
    }
}
