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
    /// Stub until the escaping change lands.
    var escapedForDisplay: RemiTranscriptEntry { self }
}
