import Foundation

/// An in-memory review of local-only historical alerts. This type does not present UI or perform
/// a broad reset; the caller must obtain a separate, explicit confirmation for each selection.
@MainActor final class LocalNoticeRecovery {
    typealias Entry = LocalNoticeInventoryRecord
    struct Candidate: Equatable {
        let identifier: String
        let title: String
        let subtitle: String
        let body: String
        let deliveredAt: Date?
        let marker: LocalNoticeMarker
    }
    struct UnassignedDebt: Equatable {
        fileprivate let ticket: LocalNoticeLedger.Ticket
        var identifierSuffix: String { String(ticket.requestID.suffix(8)) }
    }

    private let ledger: LocalNoticeLedger
    private let keys: LocalNoticeKeys
    private let remove: ([String]) -> Void

    init(ledger: LocalNoticeLedger, keys: LocalNoticeKeys, remove: @escaping ([String]) -> Void) {
        self.ledger = ledger; self.keys = keys; self.remove = remove
    }

    /// Display data is returned only in memory. An empty/partial inventory does not invalidate
    /// a historical owner. Duplicate IDs with conflicting content cannot be selected.
    func review(_ entries: [Entry]) throws -> [Candidate] {
        guard entries.count <= LocalNoticeReconciler.maximumRequests else { throw LocalNoticeError.capacity }
        var protected = try LocalNoticeReconciler.inspectInventory(entries)
        var byID: [String: Candidate] = [:], ambiguous = Set<String>()
        for entry in entries {
            guard !protected.contains(entry.identifier), entry.identifier.hasPrefix("remi.local.v1.") else { continue }
            guard !entry.protected, let marker = entry.marker,
                  try ledger.selectableHistoricalTicket(marker, keys: keys, systemIdentifier: entry.identifier) != nil
            else { protected.insert(entry.identifier); continue }
            let candidate = Candidate(identifier: entry.identifier, title: entry.title,
                subtitle: entry.subtitle, body: entry.body, deliveredAt: entry.deliveredAt, marker: marker)
            if let old = byID[entry.identifier] {
                guard old.marker == candidate.marker, old.title == candidate.title,
                      old.subtitle == candidate.subtitle, old.body == candidate.body else {
                    ambiguous.insert(entry.identifier); continue
                }
                // If both pending and delivered copies exist, prefer the most recent delivered time.
                if let date = candidate.deliveredAt, old.deliveredAt.map({ date > $0 }) ?? true {
                    byID[entry.identifier] = candidate
                }
            } else { byID[entry.identifier] = candidate }
        }
        var result: [Candidate] = []
        for candidate in byID.values where !ambiguous.contains(candidate.identifier) && !protected.contains(candidate.identifier) {
            if try ledger.selectableHistoricalTicket(candidate.marker, keys: keys,
                                                       systemIdentifier: candidate.identifier) != nil {
                result.append(candidate)
            }
        }
        return result.sorted { $0.identifier < $1.identifier }
    }

    /// Invoke only after the person confirms this exact candidate. Re-scan current OS entries
    /// first; the OS may change again afterward and its exact-ID removal has no completion.
    func confirm(_ selection: Candidate, current: [Entry]) throws {
        guard try review(current).contains(selection) else { throw LocalNoticeError.changed }
        let record = try ledger.invalidateSelectedHistorical(selection.marker, keys: keys,
                                                               systemIdentifier: selection.identifier)
        remove([selection.identifier])
        switch record.effect {
        case .settledSuccess, .settledError:
            try ledger.removalWasRequested(record.ticket)
            try ledger.retire(record.ticket)
        case .crashUncertain:
            // A callback lost at process death cannot be proved settled by an OS snapshot.
            break
        case .prepared, .adding:
            throw LocalNoticeError.corrupt
        }
    }

    /// These records have no proven profile association and expose only an opaque suffix to UI.
    func unassignedUncertain() throws -> [UnassignedDebt] {
        try ledger.unassignedUncertainTickets().map { UnassignedDebt(ticket: $0) }
    }

    /// After separate explicit confirmation of the late-banner risk, abandon one exact debt.
    /// `current` must represent both complete pending and delivered OS inventories; nil means
    /// the scan failed, never an empty center. No OS notification is removed by this operation.
    func abandonUnseen(_ selection: UnassignedDebt, current: [Entry]?) throws {
        guard let current else { throw LocalNoticeError.unavailable }
        guard current.count <= LocalNoticeReconciler.maximumRequests else { throw LocalNoticeError.capacity }
        _ = try LocalNoticeReconciler.inspectInventory(current)
        let identifier = "remi.local.v1." + selection.ticket.requestID
        guard !current.contains(where: { $0.identifier == identifier }),
              try ledger.unassignedUncertainTickets().contains(selection.ticket) else { throw LocalNoticeError.changed }
        try ledger.abandonSelectedUncertain(selection.ticket)
    }
}
