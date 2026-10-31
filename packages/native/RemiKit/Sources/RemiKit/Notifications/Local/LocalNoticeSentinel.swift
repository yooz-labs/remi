import Foundation

/// Non-secret backup-visible installation/schema signal, independent of ThisDeviceOnly key data.
/// UserDefaults flush/readback is not a cross-store transaction or a physical restore guarantee.
@MainActor struct LocalNoticeSentinel {
    static let storageKey = "remi.phone.local-notice.installation-schema"
    private static let current = "local-notice-journal-v1"
    private let defaults: UserDefaults
    private let domainName: String
    private let flush: (UserDefaults) -> Bool

    init(defaults: UserDefaults, domainName: String, flush: @escaping (UserDefaults) -> Bool = { $0.synchronize() }) {
        self.defaults = defaults; self.domainName = domainName; self.flush = flush
    }

    static func configured() throws -> Self {
        guard let domain = Bundle.main.bundleIdentifier, !domain.isEmpty else { throw LocalNoticeBootstrap.Failure.unavailable }
        return Self(defaults: .standard, domainName: domain)
    }

    func read() -> LocalNoticeBootstrap.Sentinel {
        // Registered/global fallback values are not evidence that this app wrote the sentinel.
        guard let value = defaults.persistentDomain(forName: domainName)?[Self.storageKey] else { return .absent }
        guard let text = value as? String, text == Self.current else { return .invalid }
        return .present
    }

    /// The caller must complete this before dispatching an OS add. Unknown values are preserved.
    func establish() throws {
        switch read() {
        case .invalid: throw LocalNoticeBootstrap.Failure.recoveryRequired
        case .absent: defaults.set(Self.current, forKey: Self.storageKey)
        case .present: break
        }
        // Always flush, even when an earlier attempt left the marker in memory after failure.
        guard flush(defaults), read() == .present else { throw LocalNoticeBootstrap.Failure.unavailable }
    }
}
