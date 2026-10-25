import UserNotifications

/// How Remi delivers a notification: how loudly it interrupts, and how notifications group.
///
/// One owner for the notification service extension and the two local notification paths, so a
/// question looks the same whichever way it arrives. The relay Worker never learns what kind of
/// event a push carries (the kind is sealed), so only the device can choose this.
public enum RemiPushPresentation {
    /// What kind of notification it is, as far as delivery is concerned.
    public enum Importance: Sendable, Equatable {
        /// An agent is waiting on the person. Time Sensitive: it breaks through Focus and
        /// scheduled delivery, because a held agent turn does nothing until it is answered.
        case question
        /// A finished turn or a notice: nothing is blocked, so it does not break through anything.
        case information
    }

    /// The most the thread identifier carries of a session id, so a long or hostile id cannot
    /// make an oversized grouping key.
    static let maximumSessionComponentLength = 128

    /// The group a session's notifications stack under, or nil when the session is unknown (they
    /// then group by app).
    public static func threadIdentifier(sessionID: String?) -> String? {
        guard let sessionID, !sessionID.isEmpty else { return nil }
        return "remi.session.\(sessionID.prefix(maximumSessionComponentLength))"
    }

    /// Sets the sound, interruption level, relevance and grouping of `content`.
    /// `sound` is false when the person turned notification sounds off in Remi.
    public static func apply(
        _ importance: Importance,
        sessionID: String?,
        sound: Bool = true,
        to content: UNMutableNotificationContent
    ) {
        switch importance {
        case .question:
            content.interruptionLevel = .timeSensitive
            content.relevanceScore = 1
        case .information:
            content.interruptionLevel = .active
            content.relevanceScore = 0.5
        }
        if sound { content.sound = .default }
        if let thread = threadIdentifier(sessionID: sessionID) {
            content.threadIdentifier = thread
        }
    }
}
