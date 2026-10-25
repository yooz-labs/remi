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

    /// The most bytes the thread identifier carries of a session id, so a long or hostile id
    /// cannot make an oversized grouping key.
    static let maximumSessionComponentBytes = 128

    /// The iPhone's "Notification sounds" setting, shared with the notification service
    /// extension (a separate process) through the app group.
    public static let soundsPreferenceKey = "remi.phone.notification-sounds"
    public static let sharedDefaultsSuite = "group.live.yooz.remi"

    /// Whether the person wants notification sounds. On unless they turned them off.
    public static func soundsEnabled(in defaults: UserDefaults?) -> Bool {
        defaults?.object(forKey: soundsPreferenceKey) as? Bool ?? true
    }

    /// Makes the person's choice visible to the extension.
    public static func shareSoundsPreference(_ enabled: Bool, with defaults: UserDefaults?) {
        defaults?.set(enabled, forKey: soundsPreferenceKey)
    }

    /// The sound setting the extension should follow. The Mac has no such setting.
    public static func extensionSoundsEnabled() -> Bool {
        #if os(iOS)
        soundsEnabled(in: UserDefaults(suiteName: sharedDefaultsSuite))
        #else
        true
        #endif
    }

    /// How a verified push is delivered, or nil for one that is not shown (a dismissal).
    public static func importance(for kind: VerifiedPushNotification.Kind) -> Importance? {
        switch kind {
        case .question: .question
        case .information: .information
        case .dismiss: nil
        }
    }

    /// The group a session's notifications stack under, or nil when the session is unknown (they
    /// then group by app).
    public static func threadIdentifier(sessionID: String?) -> String? {
        guard let sessionID, !sessionID.isEmpty else { return nil }
        // Bytes, not characters: a run of combining marks is one character but many bytes.
        let bounded = String(decoding: sessionID.utf8.prefix(maximumSessionComponentBytes), as: UTF8.self)
        return "remi.session.\(bounded)"
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
