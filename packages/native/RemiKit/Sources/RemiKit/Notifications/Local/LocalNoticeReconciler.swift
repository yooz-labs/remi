import Foundation
import UserNotifications

/// Scans only after the OS returns both inventories. An absent in-memory ticket is never removal
/// authority; a historical active marker remains visible through offline/partial reconnects.
@MainActor final class LocalNoticeReconciler {
    static let maximumRequests = 4_096
    static let maximumMetadataBytes = 2 * 1_024 * 1_024
    private let ledger: LocalNoticeLedger
    private let keys: LocalNoticeKeys
    private let remove: ([String]) -> Void

    init(ledger: LocalNoticeLedger, keys: LocalNoticeKeys, remove: @escaping ([String]) -> Void) {
        self.ledger = ledger; self.keys = keys; self.remove = remove
    }

    /// If the scan is too large, malformed, or storage fails, no removal is issued.
    func reconcile(_ requests: [UNNotificationRequest]) throws {
        guard requests.count <= Self.maximumRequests else { throw LocalNoticeError.capacity }
        var remaining = Self.maximumMetadataBytes
        for request in requests {
            try Self.consume(request.identifier, remaining: &remaining)
            try Self.consume(request.content.title, remaining: &remaining)
            try Self.consume(request.content.subtitle, remaining: &remaining)
            try Self.consume(request.content.body, remaining: &remaining)
            try Self.consume(request.content.userInfo, remaining: &remaining)
        }
        // Removal is identifier-based, so a same-ID remote or non-immediate request protects
        // that ID even if a separately observed local request otherwise qualifies.
        let protected = Set(requests.filter { $0.trigger != nil || $0.content.userInfo["remiPush"] != nil }.map(\.identifier))
        var candidates: [(LocalNoticeMarker, String)] = []
        for request in requests {
            // This path submits immediate local requests only. Remote or other triggered
            // requests, including anything with remiPush, are never local cleanup authority.
            guard !protected.contains(request.identifier), request.trigger == nil, request.content.userInfo["remiPush"] == nil,
                  request.identifier.hasPrefix("remi.local.v1."),
                  let marker = try? LocalNoticeMarker.parse(userInfo: request.content.userInfo)
            else { continue }
            switch try ledger.classify(marker, keys: keys, systemIdentifier: request.identifier) {
            case .retired, .invalidated: candidates.append((marker, request.identifier))
            case .currentActive, .historicalActive, .unknown, .quarantined: break
            }
        }
        // A later marker in the same scan may have quarantined its owner. Check every
        // candidate again after the complete scan before authorizing any removal.
        var removable = Set<String>()
        for (marker, identifier) in candidates {
            switch try ledger.classify(marker, keys: keys, systemIdentifier: identifier) {
            case .retired, .invalidated: removable.insert(identifier)
            case .currentActive, .historicalActive, .unknown, .quarantined: break
            }
        }
        if !removable.isEmpty { remove(removable.sorted()) }
    }

    /// Walk only bounded property-list metadata, without serializing an unbounded OS array.
    private static func consume(_ root: Any, remaining: inout Int) throws {
        var stack: [Any] = [root], nodes = 0
        while let value = stack.popLast() {
            nodes += 1
            guard nodes <= 16_384 else { throw LocalNoticeError.capacity }
            let size: Int
            switch value {
            case let value as String: size = value.utf8.count
            case let value as Data: size = value.count
            case is NSNumber, is Date, is NSNull: size = 16
            case let value as [Any]:
                guard value.count <= 16_384 - nodes else { throw LocalNoticeError.capacity }
                stack.append(contentsOf: value); size = 16
            case let value as [AnyHashable: Any]:
                guard value.count <= (16_384 - nodes) / 2 else { throw LocalNoticeError.capacity }
                for (key, item) in value { stack.append(key.base); stack.append(item) }
                size = 16
            default: throw LocalNoticeError.invalid
            }
            guard size <= remaining else { throw LocalNoticeError.capacity }
            remaining -= size
        }
    }
}
