import Foundation

/// Per-device preferences for the existing secure push registration fields.
/// Quiet dismissals and host-configured subagent alerts are controlled by the host.
public struct NativeNotificationPreferences: Encodable, Sendable, Equatable {
    #if os(iOS)
    public static let questionsKey = "remi.phone.question-notifications"
    #else
    public static let questionsKey = "remi.mac.question-notifications"
    #endif
    public static let turnCompleteKey = "remi.native.turn-complete-notifications"

    public let questions: Bool
    public let turnComplete: Bool
    public let harnessDenied: Bool
    public let turnFailed: Bool

    public init(questions: Bool = true, turnComplete: Bool = false) {
        self.questions = questions
        self.turnComplete = turnComplete
        harnessDenied = false
        turnFailed = false
    }

    public static func read(from defaults: UserDefaults) -> Self {
        Self(questions: defaults.object(forKey: questionsKey) as? Bool ?? true,
             turnComplete: defaults.object(forKey: turnCompleteKey) as? Bool ?? false)
    }
}
