/// Transient send feedback held only in memory and never persisted. A tile owns its local fallback,
/// while a containing screen may own keyed state when layout changes can rebuild the tile. A
/// retry sets `isSending` and preserves an earlier failure notice; a failure completion keeps that
/// notice, while a successful completion clears the state. The screen drops the entry when the
/// session is pruned. If both flags are true, sending wins.
public struct RemiBoardTileSendState: Equatable, Sendable {
    /// Whether the tile's current message is still being sent, even if an earlier failure remains visible.
    public let isSending: Bool
    /// Whether the most recent completed send failed; a retry preserves this notice while in flight.
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
    static func canSend(draft: String, isLive: Bool, state: RemiBoardTileSendState) -> Bool {
        isLive
            && !state.isSending
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Chooses screen-owned state when supplied, preserving a tile's local state otherwise.
    /// - Parameters:
    ///   - external: Optional state owned by a containing screen.
    ///   - fallback: The tile's own state when no external state is supplied.
    static func selectedSendState(
        external: RemiBoardTileSendState?,
        fallback: RemiBoardTileSendState
    ) -> RemiBoardTileSendState {
        external ?? fallback
    }

    /// Applies one send-state update without recreating a key after its entry was pruned.
    /// Sending takes precedence when both flags are set. A failure only replaces an existing entry,
    /// so a late failure completion cannot resurrect a dropped session; an idle state removes it.
    /// - Parameters:
    ///   - state: The incoming send state.
    ///   - key: The tile key that owns the state.
    ///   - states: The current in-memory send-state dictionary.
    /// - Returns: The updated dictionary.
    public static func storing(
        _ state: RemiBoardTileSendState,
        forKey key: String,
        in states: [String: RemiBoardTileSendState]
    ) -> [String: RemiBoardTileSendState] {
        var updated = states
        if state.isSending {
            updated[key] = state
        } else if state.sendFailed {
            if updated[key] != nil { updated[key] = state }
        } else {
            updated[key] = nil
        }
        return updated
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
