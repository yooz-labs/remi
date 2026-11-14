/// Transient send feedback for one Board tile.
public struct RemiBoardTileSendState: Equatable, Sendable {
    /// Whether the tile's current message is still being sent.
    public let isSending: Bool
    /// Whether the most recent send failed and should keep its notice visible.
    public let sendFailed: Bool

    /// Creates send feedback for a tile.
    /// - Parameters:
    ///   - isSending: Whether a send is in flight.
    ///   - sendFailed: Whether the most recent send failed.
    public init(isSending: Bool = false, sendFailed: Bool = false) {
        self.isSending = isSending
        self.sendFailed = sendFailed
    }
}

/// Pure decisions shared by Board tiles and their containing screens.
public enum RemiBoardTileStateRules {
    /// Returns whether a live tile may send its current draft.
    /// - Parameters:
    ///   - draft: The text currently in the tile's composer.
    ///   - isLive: Whether the session can accept a message.
    ///   - state: The tile's current transient send feedback.
    public static func canSend(draft: String, isLive: Bool, state: RemiBoardTileSendState) -> Bool {
        isLive
            && !state.isSending
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Chooses screen-owned state when supplied, preserving a tile's local state otherwise.
    /// - Parameters:
    ///   - external: Optional state owned by a containing screen.
    ///   - fallback: The tile's own state when no external state is supplied.
    public static func selectedSendState(
        external: RemiBoardTileSendState?,
        fallback: RemiBoardTileSendState
    ) -> RemiBoardTileSendState {
        external ?? fallback
    }

    /// Keeps focus only when that key still has a composer after a layout change.
    /// - Parameters:
    ///   - focusedKey: The key focused before the tile container changed.
    ///   - composerKeys: Keys with working composers in the new layout.
    public static func focusAfterLayoutChange(focusedKey: String?, composerKeys: Set<String>) -> String? {
        guard let focusedKey, composerKeys.contains(focusedKey) else { return nil }
        return focusedKey
    }
}
