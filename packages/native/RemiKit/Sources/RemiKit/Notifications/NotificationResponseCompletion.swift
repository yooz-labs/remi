import Foundation

/// Completes a notification response on the main actor after its handling ends.
public enum NotificationResponseCompletion {
    public nonisolated static func perform(
        _ operation: @escaping @MainActor @Sendable () async -> Void,
        completion: @escaping @Sendable () -> Void
    ) {
        Task { @MainActor in
            await operation()
            completion()
        }
    }
}
