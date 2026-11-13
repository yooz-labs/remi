/// Which question a session screen brings to the top. A requested question that has not
/// loaded yet stays pending until it appears, instead of being dropped.
public struct PhoneQuestionFocusState: Equatable, Sendable {
    /// The question shown first and announced; always one that is loaded.
    public private(set) var focused: String?
    /// A question that was asked for but is not loaded yet.
    public private(set) var pending: String?

    public init() {}

    public init(initial: String?, loaded: [String]) {
        if let initial { request(initial, loaded: loaded) }
    }

    /// Replaces any earlier focus or pending request.
    public mutating func request(_ id: String, loaded: [String]) {
        if loaded.contains(id) {
            focused = id
            pending = nil
        } else {
            focused = nil
            pending = id
        }
    }

    /// Promotes a pending question once it loads, and drops a focus whose question left.
    public mutating func questionsChanged(_ loaded: [String]) {
        if let pending, loaded.contains(pending) {
            focused = pending
            self.pending = nil
        } else if let focused, !loaded.contains(focused) {
            self.focused = nil
        }
    }

    /// The person moved on: another conversation, or another question.
    public mutating func clear() {
        focused = nil
        pending = nil
    }
}
