import Foundation
import Observation
import RemiPush
#if os(iOS)
import UIKit
#endif

/// App-facing local alert review owner. Store-driven scheduling is deliberately unavailable
/// until ordered, current socket episodes are integrated; secure push remains independent.
@MainActor @Observable public final class NativeLocalNotificationOwner {
    public enum Phase: Sendable, Equatable {
        case idle, starting, reviewOnly, pendingForget(Int), locked, recoveryRequired, unavailable, capacity
    }
    public enum ActionOutcome: Sendable, Equatable { case completed, changed, unavailable }
    public struct EarlierAlert: Sendable, Identifiable, Equatable {
        public let id: UUID
        public let title: String
        public let subtitle: String
        public let body: String
        public let deliveredAt: Date?
    }
    public struct UnassignedDebt: Sendable, Identifiable, Equatable {
        public let id: UUID
        public let identifierSuffix: String
    }
    public struct AlertConfirmation: Sendable {
        fileprivate let id: UUID
        fileprivate let epoch: UUID
        fileprivate let review: UUID
    }
    public struct DebtConfirmation: Sendable {
        fileprivate let id: UUID
        fileprivate let epoch: UUID
        fileprivate let review: UUID
    }

    public private(set) var phase: Phase = .idle
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let sentinel: LocalNoticeSentinel
    @ObservationIgnored private let keyStore: LocalNoticeKeyStore
    @ObservationIgnored private let operations: NativeKeychainOperations
    @ObservationIgnored private let inventory: LocalNoticeInventory
    @ObservationIgnored private let protectedDataAvailable: @MainActor () -> Bool
    @ObservationIgnored private let notificationBoundary: LocalNoticeBoundary
    @ObservationIgnored private var epoch = UUID()
    @ObservationIgnored private var alertReview = UUID()
    @ObservationIgnored private var debtReview = UUID()
    @ObservationIgnored private var alerts: [UUID: LocalNoticeRecovery.Candidate] = [:]
    @ObservationIgnored private var debts: [UUID: LocalNoticeRecovery.UnassignedDebt] = [:]
    @ObservationIgnored private var ready: LocalNoticeStartup.Ready?
    @ObservationIgnored private var recoveryAccess: LocalNoticeStartup.RecoveryAccess?
    @ObservationIgnored private var startupTask: Task<LocalNoticeStartup.Ready, any Error>?
    @ObservationIgnored private var scanTask: Task<LocalNoticeInventory.Snapshot, any Error>?
    @ObservationIgnored private var scanID: UUID?

    init(directory: URL, sentinel: LocalNoticeSentinel, keyStore: LocalNoticeKeyStore,
         operations: NativeKeychainOperations = .system, inventory: LocalNoticeInventory,
         protectedDataAvailable: @escaping @MainActor () -> Bool, notificationBoundary: LocalNoticeBoundary = .system) {
        self.directory = directory; self.sentinel = sentinel; self.keyStore = keyStore; self.operations = operations
        self.inventory = inventory; self.protectedDataAvailable = protectedDataAvailable; self.notificationBoundary = notificationBoundary
    }

    public static func configured() throws -> NativeLocalNotificationOwner {
        #if os(iOS)
        return try NativeLocalNotificationOwner(directory: LocalNoticeBootstrap.appPrivateDirectory(),
            sentinel: LocalNoticeSentinel.configured(), keyStore: LocalNoticeKeyStore(),
            inventory: LocalNoticeInventory(), protectedDataAvailable: { UIApplication.shared.isProtectedDataAvailable })
        #else
        throw LocalNoticeBootstrap.Failure.unavailable
        #endif
    }

    /// Startup may scan and reconcile proven local tombstones, but never schedules a question.
    public func start() async {
        guard startupTask == nil, ready == nil, recoveryAccess == nil else { return }
        let current = UUID(); epoch = current; phase = .starting
        let task = Task { @MainActor in
            try await LocalNoticeStartup.open(directory: directory, sentinel: sentinel, keyStore: keyStore,
                operations: operations, inventory: inventory, protectedDataAvailable: protectedDataAvailable,
                notificationBoundary: notificationBoundary)
        }
        startupTask = task
        do {
            let opened = try await task.value
            guard epoch == current else { opened.ledger.close(); return }
            startupTask = nil; ready = opened; phase = .reviewOnly
        } catch {
            guard epoch == current else { return }
            startupTask = nil
            if error as? LocalNoticeBootstrap.Failure == .pendingForget {
                do {
                    let access = try LocalNoticeStartup.openRecovery(directory: directory, keyStore: keyStore,
                        operations: operations, protectedDataAvailable: protectedDataAvailable(), remove: notificationBoundary.remove)
                    recoveryAccess = access; phase = .pendingForget(access.pendingForgetCount)
                } catch { phase = phaseForFailure(error) }
            } else { phase = phaseForFailure(error) }
        }
    }

    public func stop() {
        epoch = UUID(); startupTask?.cancel(); startupTask = nil; scanTask?.cancel(); scanTask = nil; scanID = nil
        ready?.ledger.close(); ready = nil; recoveryAccess?.close(); recoveryAccess = nil
        alerts.removeAll(); debts.removeAll(); alertReview = UUID(); debtReview = UUID(); phase = .idle
    }

    /// This does not remove, answer, or associate any alert with a current profile.
    public func reviewEarlierAlerts() async throws -> [EarlierAlert] {
        let current = epoch
        guard currentRecovery != nil else { throw LocalNoticeError.unavailable }
        let snapshot = try await readInventory()
        guard current == epoch, let recovery = currentRecovery else { throw LocalNoticeError.changed }
        let candidates = try recovery.review(snapshot.entries)
        alertReview = UUID(); alerts.removeAll()
        return candidates.map { candidate in
            let id = UUID(); alerts[id] = candidate
            return EarlierAlert(id: id, title: candidate.title, subtitle: candidate.subtitle,
                                body: candidate.body, deliveredAt: candidate.deliveredAt)
        }
    }

    /// The UI must show the selected alert and obtain an explicit per-alert confirmation.
    public func prepareAlertConfirmation(_ id: UUID) -> AlertConfirmation? {
        guard currentRecovery != nil, alerts[id] != nil else { return nil }
        return AlertConfirmation(id: id, epoch: epoch, review: alertReview)
    }

    public func confirmAlert(_ confirmation: AlertConfirmation) async -> ActionOutcome {
        guard valid(confirmation), let candidate = alerts[confirmation.id] else { return .changed }
        do {
            let snapshot = try await readInventory()
            guard valid(confirmation), let recovery = currentRecovery else { return .changed }
            try recovery.confirm(candidate, current: snapshot.entries)
            alerts.removeAll(); alertReview = UUID()
            return .completed
        } catch LocalNoticeError.changed {
            alerts.removeAll(); alertReview = UUID(); return .changed
        } catch { return valid(confirmation) ? .unavailable : .changed }
    }

    /// Unassigned records reveal an opaque suffix only; there is no inferred profile association.
    public func reviewUnassignedDebt() throws -> [UnassignedDebt] {
        guard let recovery = currentRecovery else { throw LocalNoticeError.unavailable }
        let candidates = try recovery.unassignedUncertain()
        debtReview = UUID(); debts.removeAll()
        return candidates.map { candidate in
            let id = UUID(); debts[id] = candidate
            return UnassignedDebt(id: id, identifierSuffix: candidate.identifierSuffix)
        }
    }

    /// The UI must separately explain that an old banner can still appear, then obtain confirmation.
    public func prepareDebtConfirmation(_ id: UUID) -> DebtConfirmation? {
        guard currentRecovery != nil, debts[id] != nil else { return nil }
        return DebtConfirmation(id: id, epoch: epoch, review: debtReview)
    }

    public func confirmAbandoningDebt(_ confirmation: DebtConfirmation) async -> ActionOutcome {
        guard valid(confirmation), let candidate = debts[confirmation.id] else { return .changed }
        do {
            let snapshot = try await readInventory()
            guard valid(confirmation), let recovery = currentRecovery else { return .changed }
            try recovery.abandonUnseen(candidate, current: snapshot.entries)
            debts.removeAll(); debtReview = UUID()
            return .completed
        } catch LocalNoticeError.changed {
            debts.removeAll(); debtReview = UUID(); return .changed
        } catch { return valid(confirmation) ? .unavailable : .changed }
    }

    private var currentRecovery: LocalNoticeRecovery? { ready?.recovery ?? recoveryAccess?.recovery }
    private func valid(_ value: AlertConfirmation) -> Bool {
        value.epoch == epoch && value.review == alertReview && alerts[value.id] != nil && currentRecovery != nil
    }
    private func valid(_ value: DebtConfirmation) -> Bool {
        value.epoch == epoch && value.review == debtReview && debts[value.id] != nil && currentRecovery != nil
    }
    private func readInventory() async throws -> LocalNoticeInventory.Snapshot {
        guard scanTask == nil else { throw LocalNoticeError.busy }
        let id = UUID(), task = Task { @MainActor in try await inventory.read() }
        scanID = id; scanTask = task
        defer { if scanID == id { scanID = nil; scanTask = nil } }
        return try await task.value
    }
    private func phaseForFailure(_ error: any Error) -> Phase {
        switch error as? LocalNoticeBootstrap.Failure {
        case .locked: .locked
        case .recoveryRequired: .recoveryRequired
        case .capacity: .capacity
        case .pendingForget, .unavailable, .none: .unavailable
        }
    }
}
