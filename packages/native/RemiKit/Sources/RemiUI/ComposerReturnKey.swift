import SwiftUI

/// What the Return key does in the message field on the Mac: Return sends, Shift+Return (or
/// Option+Return) starts a new line, the way chat apps work. The phone keeps Return as a new
/// line, since it has a send button under the thumb.
///
/// Kept apart from the view so the rule is tested.
public enum RemiComposerReturnKey {
    public enum Action: Equatable, Sendable {
        /// Send the message.
        case send
        /// Leave the key to the text field: a new line, or confirming an input method's text.
        case passThrough
        /// Do nothing: Return with nothing to send must not add a blank line.
        case ignore
    }

    /// `isComposing` is true while an input method (Japanese, Chinese, Korean, accents) has
    /// text it has not committed yet; Return then confirms that text and must not send.
    public static func action(modifiers: EventModifiers, canSend: Bool, isComposing: Bool) -> Action {
        if isComposing { return .passThrough }
        if modifiers.contains(.shift) || modifiers.contains(.option) { return .passThrough }
        return canSend ? .send : .ignore
    }
}
