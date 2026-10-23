import Foundation

/// What a conversation shows in place of (or above) its entries.
///
/// A conversation that is still loading must not claim to be empty: the transcript arrives as
/// a stream of entries after the request, and a long one takes seconds (#1602).
public enum RemiConversationPlaceholder: Equatable, Sendable {
    /// Entries are showing and nothing is loading.
    case none
    /// Nothing has arrived yet and the load is in flight.
    case loading
    /// Entries are arriving and the load has not finished.
    case loadingMore
    /// The load finished (or never started) and there is nothing to show.
    case empty

    public static func resolve(isLoading: Bool, hasEntries: Bool) -> Self {
        switch (isLoading, hasEntries) {
        case (true, false): .loading
        case (true, true): .loadingMore
        case (false, false): .empty
        case (false, true): .none
        }
    }
}

/// A long message shows a preview and expands on request, so one huge entry (a pasted log, a
/// continuation summary) does not become a many-thousand-point bubble (#1602).
public struct RemiMessageCollapse: Equatable, Sendable {
    /// Characters shown while collapsed.
    public static let characterLimit = 1_500
    /// A message only collapses when at least this many characters would be hidden.
    public static let minimumHidden = 500

    public let preview: String
    public let hiddenCharacterCount: Int

    public var isCollapsible: Bool { hiddenCharacterCount > 0 }

    public init(text: String) {
        let count = text.count
        guard count >= Self.characterLimit + Self.minimumHidden else {
            preview = text
            hiddenCharacterCount = 0
            return
        }
        let head = text.prefix(Self.characterLimit)
        // Prefer a paragraph or word boundary in the last 30 percent of the preview.
        let region = head[head.index(head.startIndex, offsetBy: Self.characterLimit * 7 / 10)...]
        let cut = region.lastIndex(where: \.isNewline) ?? region.lastIndex(of: " ") ?? head.endIndex
        var shown = String(head[..<cut])
        while let last = shown.last, last.isWhitespace || last.isNewline { shown.removeLast() }
        preview = shown
        hiddenCharacterCount = count - shown.count
    }
}
