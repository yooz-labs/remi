import Foundation
import Observation
import UserNotifications
import RemiPush

/// OS boundary for local notifications. No answer or relay authority is held here.
@MainActor struct LocalNoticeBoundary {
    var authorized: () async -> Bool
    var identifierAvailable: (String) async throws -> Bool
    var add: (UNNotificationRequest) async throws -> Void
    var remove: ([String]) -> Void

    static var system: Self {
        .init(authorized: {
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            if status == .authorized || status == .provisional { return true }
            #if os(iOS)
            return status == .ephemeral
            #else
            return false
            #endif
        }, identifierAvailable: { id in
            let center = UNUserNotificationCenter.current()
            let pending = await center.pendingNotificationRequests()
            let delivered = await center.deliveredNotifications()
            guard pending.count <= LocalNoticeReconciler.maximumRequests,
                  delivered.count <= LocalNoticeReconciler.maximumRequests - pending.count else { throw LocalNoticeError.capacity }
            var remaining = LocalNoticeReconciler.maximumMetadataBytes
            for identifier in pending.map(\.identifier) + delivered.map(\.request.identifier) {
                let count = identifier.utf8.count
                guard count <= remaining else { throw LocalNoticeError.capacity }
                remaining -= count
                if identifier == id { return false }
            }
            return true
        }, add: { request in try await UNUserNotificationCenter.current().add(request) }, remove: { ids in
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: ids)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        })
    }
}

/// One process owner for local notification intents. Journal writes precede effects; no timeout
/// turns an unacknowledged OS operation into a claimed success (#1720).
@MainActor @Observable final class LocalNoticeLifecycle {
    struct LogicalID: Hashable {
        let owner: UUID
        let sessionID: String
        let questionID: String
    }
    struct Intent {
        let owner: UUID
        let sessionID: String
        let questionID: String
        let title: String
        let body: String
        let sound: Bool
        let summaries: Bool
        /// Checks actual current Store authority and preferences; never persisted or logged.
        let isCurrent: @MainActor () -> Bool
        var id: LogicalID { .init(owner: owner, sessionID: sessionID, questionID: questionID) }
    }
    private struct Active {
        let token: UUID
        let eligibility: UUID
        let ticket: LocalNoticeLedger.Ticket
    }
    private let ledger: LocalNoticeLedger
    private let keys: LocalNoticeKeys
    private let boundary: LocalNoticeBoundary
    private let addWarningDelay: Duration
    private var owners: [UUID: Data] = [:]
    private var active: [LogicalID: Active] = [:]
    private var running: Set<UUID> = []
    private var blockedOwners: Set<UUID> = []
    private var eligibility = UUID()
    private(set) var warning: String?

    init(ledger: LocalNoticeLedger, keys: LocalNoticeKeys, boundary: LocalNoticeBoundary = .system,
         addWarningDelay: Duration = .seconds(10)) {
        self.ledger = ledger; self.keys = keys; self.boundary = boundary; self.addWarningDelay = addWarningDelay
    }

    /// Starts one ticket only after durable preparation. A repeat of the same live question
    /// does not create another request; a later incarnation receives a new opaque UUID.
    func schedule(_ intent: Intent) {
        guard !blockedOwners.contains(intent.owner), intent.isCurrent() else { return }
        if let existing = active[intent.id] {
            guard !running.contains(existing.token) else { return }
            do {
                guard try ledger.record(existing.ticket).effect == .prepared else { return }
                launch(intent, active: existing)
            } catch { fail() }
            return
        }
        do {
            let owner: Data
            if let existing = owners[intent.owner] { owner = existing }
            else {
                owner = try keys.ownerIndex(runtimeOwner: intent.owner)
                try ledger.createOwner(owner); owners[intent.owner] = owner
            }
            let question = try keys.questionIndex(owner: owner, sessionID: intent.sessionID, questionID: intent.questionID)
            let ticket = try ledger.prepare(owner: owner, question: question)
            let value = Active(token: UUID(), eligibility: eligibility, ticket: ticket)
            active[intent.id] = value
            launch(intent, active: value)
        } catch { fail() }
    }

    private func launch(_ intent: Intent, active value: Active) {
        running.insert(value.token)
        observePending(value.token)
        Task { [weak self] in await self?.deliver(intent, active: value) }
    }

    /// Only an authoritative current-owner resolution/snapshot invokes this method.
    func resolve(_ id: LogicalID) {
        guard let value = active.removeValue(forKey: id) else { return }
        do { try ledger.invalidate(value.ticket); try cleanupIfSettled(value.ticket, deferRetirement: running.contains(value.token)) }
        catch {
            boundary.remove(["remi.local.v1." + value.ticket.requestID]); fail()
        }
    }

    /// Preference changes invalidate all current tickets before any pending async work resumes.
    func invalidateEligibility() {
        eligibility = UUID()
        let old = active; active.removeAll()
        for (_, value) in old {
            do { try ledger.invalidate(value.ticket); try cleanupIfSettled(value.ticket, deferRetirement: running.contains(value.token)) }
            catch { boundary.remove(["remi.local.v1." + value.ticket.requestID]); fail() }
        }
    }

    /// Must return true before the caller forgets a current profile; false leaves it intact.
    func retireOwner(_ owner: UUID) -> Bool {
        blockedOwners.insert(owner)
        let old = active.filter { $0.key.owner == owner }
        for key in old.keys { active.removeValue(forKey: key) }
        guard let index = owners[owner] else { return true }
        do {
            try ledger.invalidateOwner(index)
            for (_, value) in old { try cleanupIfSettled(value.ticket, deferRetirement: running.contains(value.token)) }
            return true
        } catch { fail(); return false }
    }

    private func currentToken(_ intent: Intent, _ value: Active) -> Bool {
        guard let latest = active[intent.id] else { return false }
        return latest.token == value.token && latest.eligibility == eligibility &&
            value.eligibility == eligibility && !blockedOwners.contains(intent.owner)
    }

    private func deliver(_ intent: Intent, active value: Active) async {
        defer { running.remove(value.token) }
        guard currentToken(intent, value), intent.isCurrent() else { return }
        guard await boundary.authorized() else { invalidateIfCurrent(intent.id, token: value.token); return }
        guard currentToken(intent, value), intent.isCurrent() else { return }
        let summary = intent.summaries
            ? await QuestionNotificationSummarizer.shared.summary(questionID: value.ticket.requestID, text: intent.body)
            : QuestionNotificationSummarizer.fallback(for: intent.body)
        guard currentToken(intent, value), intent.isCurrent() else { return }
        guard await boundary.authorized() else { invalidateIfCurrent(intent.id, token: value.token); return }
        guard currentToken(intent, value), intent.isCurrent() else { return }
        var addStarted = false
        do {
            let marker = try keys.marker(requestID: value.ticket.requestID, owner: value.ticket.owner,
                sequence: value.ticket.sequence, question: value.ticket.question)
            let content = UNMutableNotificationContent()
            content.title = intent.title; content.body = summary; content.userInfo = try marker.userInfo()
            // The shared grouping helper embeds its input in the OS thread identifier. Keep
            // the raw session ID out of this local notification's metadata (#1720).
            RemiPushPresentation.apply(.question, sessionID: nil, sound: intent.sound, to: content)
            let request = UNNotificationRequest(identifier: marker.systemIdentifier, content: content, trigger: nil)
            guard try await boundary.identifierAvailable(request.identifier) else { fail(); return }
            guard currentToken(intent, value), intent.isCurrent() else { return }
            guard await boundary.authorized() else { invalidateIfCurrent(intent.id, token: value.token); return }
            guard currentToken(intent, value), intent.isCurrent() else { return }
            try ledger.beginAdd(value.ticket)
            addStarted = true
            var succeeded = false
            do { try await boundary.add(request); succeeded = true }
            catch { fail() }
            try ledger.settle(value.ticket, succeeded: succeeded)
            // Authorization may change during add. An invalidated in-flight ticket is always
            // removed again after settlement, and its old UUID cannot target a newer ticket.
            let authorized = await boundary.authorized()
            if !succeeded || !authorized { invalidateIfCurrent(intent.id, token: value.token) }
            if !currentToken(intent, value) {
                // Even a failed journal invalidation must not leave a settled stale request.
                boundary.remove(["remi.local.v1." + value.ticket.requestID])
                try cleanupIfSettled(value.ticket, deferRetirement: false)
            }
        } catch {
            if addStarted { boundary.remove(["remi.local.v1." + value.ticket.requestID]) }
            fail()
        }
    }

    private func invalidateIfCurrent(_ id: LogicalID, token: UUID) {
        guard active[id]?.token == token else { return }
        resolve(id)
    }
    /// This only surfaces a suspended operation. It does not cancel an add or settle its debt.
    private func observePending(_ token: UUID) {
        let delay = addWarningDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, self.running.contains(token) else { return }
            self.fail()
        }
    }
    private func cleanupIfSettled(_ ticket: LocalNoticeLedger.Ticket, deferRetirement: Bool) throws {
        let state = try ledger.record(ticket)
        guard state.activity == .invalidated else { return }
        switch state.effect {
        case .prepared:
            try ledger.retire(ticket)
        case .adding, .crashUncertain:
            boundary.remove(["remi.local.v1." + ticket.requestID])
        case .settledSuccess, .settledError:
            boundary.remove(["remi.local.v1." + ticket.requestID])
            guard !deferRetirement else { return }
            try ledger.removalWasRequested(ticket)
            try ledger.retire(ticket)
        }
    }
    private func fail() { warning = "A local notification could not be scheduled or cleared. Open Remi to review current requests." }
}
