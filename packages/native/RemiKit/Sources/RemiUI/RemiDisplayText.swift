import RemiPush

/// Escapes text another party chose (a name, a path, a message) before it is shown, where
/// control or bidirectional characters could mislead. This is `PushDisplayText.escape`, the
/// Swift counterpart of `escapeUnsafeText` in `packages/shared/src/display-text.ts`; the
/// rules live only there. The display models in this module already escape their own
/// fields; use this for a raw string a view shows directly.
public enum RemiDisplayText {
    public static func escape(_ text: String) -> String { PushDisplayText.escape(text) }
}

public extension RemiTranscriptEntry {
    /// The entry with every text field escaped (``RemiDisplayText``); newlines and tabs stay.
    /// For the board's tiles, which show a few entries at a glance; the full conversation view
    /// does not use it.
    var escapedForDisplay: RemiTranscriptEntry {
        switch self {
        case .user(let id, let text): .user(id: id, text: RemiDisplayText.escape(text))
        case .pending(let id, let text, let state): .pending(id: id, text: RemiDisplayText.escape(text), state: state)
        case .agent(let id, let text): .agent(id: id, text: RemiDisplayText.escape(text))
        case .error(let id, let text): .error(id: id, text: RemiDisplayText.escape(text))
        case .tool(let id, let name, let summary):
            .tool(id: id, name: RemiDisplayText.escape(name), summary: RemiDisplayText.escape(summary))
        }
    }
}
