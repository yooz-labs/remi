import Foundation

/// Scans only after the OS returns both inventories. An absent in-memory ticket is never removal
/// authority; a historical active marker remains visible through offline/partial reconnects.
@MainActor final class LocalNoticeReconciler {
    static let maximumRequests = LocalNoticeInventoryLimits.maximumRequests
    static let maximumMetadataBytes = LocalNoticeInventoryLimits.maximumMetadataBytes
    private let ledger: LocalNoticeLedger
    private let keys: LocalNoticeKeys
    private let remove: ([String]) -> Void

    init(ledger: LocalNoticeLedger, keys: LocalNoticeKeys, remove: @escaping ([String]) -> Void) {
        self.ledger = ledger; self.keys = keys; self.remove = remove
    }

    /// If the scan is too large, malformed, or storage fails, no removal is issued.
    func reconcile(_ entries: [LocalNoticeInventoryRecord]) throws {
        var protected = try Self.inspectInventory(entries)
        var candidates: [(LocalNoticeMarker, String)] = []
        for entry in entries {
            guard !protected.contains(entry.identifier), entry.identifier.hasPrefix("remi.local.v1.") else { continue }
            guard !entry.protected, let marker = entry.marker else { protected.insert(entry.identifier); continue }
            switch try ledger.classify(marker, keys: keys, systemIdentifier: entry.identifier) {
            case .retired, .invalidated: candidates.append((marker, entry.identifier))
            case .currentActive, .historicalActive, .unknown, .quarantined: protected.insert(entry.identifier)
            }
        }
        // A later marker in the same scan may have quarantined its owner. Check every
        // candidate again after the complete scan before authorizing any removal.
        var removable = Set<String>()
        for (marker, identifier) in candidates where !protected.contains(identifier) {
            switch try ledger.classify(marker, keys: keys, systemIdentifier: identifier) {
            case .retired, .invalidated: removable.insert(identifier)
            case .currentActive, .historicalActive, .unknown, .quarantined: break
            }
        }
        if !removable.isEmpty { remove(removable.sorted()) }
    }

    /// The OS callback already charged all raw metadata; recheck the immutable projection's
    /// aggregate before either automatic cleanup or explicitly selected recovery.
    static func inspectInventory(_ entries: [LocalNoticeInventoryRecord]) throws -> Set<String> {
        guard entries.count <= maximumRequests else { throw LocalNoticeError.capacity }
        var remaining = maximumMetadataBytes
        for entry in entries {
            guard entry.metadataBytes >= 0, entry.metadataBytes <= remaining else { throw LocalNoticeError.capacity }
            remaining -= entry.metadataBytes
        }
        return Set(entries.filter(\.protected).map(\.identifier))
    }
}
