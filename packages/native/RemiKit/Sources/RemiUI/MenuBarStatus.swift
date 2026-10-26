import Foundation

/// What the Mac menu bar item shows and says: nothing waiting, requests waiting, or no identity.
///
/// Kept apart from the view so the rule (which state, which words) is tested. The icon is drawn
/// by `RemiMenuBarIcon`: outlined while nothing waits, filled while something does.
public struct RemiMenuBarStatus: Equatable, Sendable {
    public let pendingCount: Int
    public let identityAvailable: Bool

    public init(pendingCount: Int, identityAvailable: Bool) {
        self.pendingCount = max(0, pendingCount)
        self.identityAvailable = identityAvailable
    }

    /// Something needs the person. Without a device identity nothing can be answered, so a count
    /// is not shown for it and the icon says the app is unavailable instead.
    public var needsYou: Bool { identityAvailable && pendingCount > 0 }

    /// The number beside the icon, only while something waits.
    public var count: Int? { needsYou ? pendingCount : nil }

    /// What VoiceOver says, so the filled state is not only visual.
    public var accessibilityLabel: LocalizedStringResource {
        guard identityAvailable else { return "Remi unavailable" }
        if pendingCount == 0 { return "Remi, no pending requests" }
        if pendingCount == 1 { return "Remi, 1 pending request" }
        return "Remi, \(pendingCount) pending requests"
    }
}
