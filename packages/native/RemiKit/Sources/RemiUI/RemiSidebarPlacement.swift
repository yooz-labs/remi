import SwiftUI

/// Resolves sidebar visibility from the window width and the person's explicit choice.
///
/// Without an explicit choice, visibility follows `RemiBoardColumns.sidebarBeside(windowWidth:)`:
/// the sidebar is hidden below 1000 points and shown at or above 1000 points. An explicit choice
/// overrides that default visibility. It does not change the width-derived `isBeside` result, so
/// showing the sidebar below the threshold places it beside and narrows the detail.
public struct RemiSidebarPlacement: Equatable, Sendable {
    /// A persisted choice that overrides the width-based default visibility.
    public enum ExplicitChoice: String, Equatable, Sendable {
        /// The person chose to show the sidebar.
        case shown
        /// The person chose to hide the sidebar.
        case hidden

        /// Parses the exact persisted values `shown` and `hidden`; all other strings mean no choice.
        public init?(storageValue: String) {
            self.init(rawValue: storageValue)
        }

        /// The stable string stored for this choice: `shown` or `hidden`.
        public var storageValue: String { rawValue }
    }

    /// The effective split-view visibility after applying any explicit choice.
    public let visibility: NavigationSplitViewVisibility
    /// Whether the sidebar is visible and the window meets the Board's beside-width threshold.
    public let isBeside: Bool

    /// Creates a placement for a measured window width and an optional persisted choice.
    ///
    /// A `nil` width means the window has not been measured yet and uses the narrow-window default.
    /// Nonfinite or negative widths are also treated as narrow. An explicit choice still overrides
    /// default visibility at those widths.
    public init(windowWidth: CGFloat?, explicitChoice: ExplicitChoice? = nil) {
        let safeWindowWidth: CGFloat
        if let windowWidth, windowWidth.isFinite, windowWidth >= 0 {
            safeWindowWidth = windowWidth
        } else {
            safeWindowWidth = 0
        }
        let wideEnoughForBeside = RemiBoardColumns.sidebarBeside(windowWidth: safeWindowWidth)
        let isShown = explicitChoice.map { $0 == .shown } ?? wideEnoughForBeside

        visibility = isShown ? .all : .detailOnly
        isBeside = isShown && wideEnoughForBeside
    }

    /// Returns the choice represented by a visibility change, or `nil` if it changes nothing.
    ///
    /// `.detailOnly` means hidden. `.all`, `.doubleColumn`, and `.automatic` mean shown. Visibility
    /// is compared by that hidden-versus-shown meaning, so equivalent visible values are redundant.
    /// - Parameters:
    ///   - requestedVisibility: The visibility requested by the split view or toggle.
    ///   - currentVisibility: The current effective split-view visibility.
    public static func choiceToRecord(
        requestedVisibility: NavigationSplitViewVisibility,
        currentVisibility: NavigationSplitViewVisibility
    ) -> ExplicitChoice? {
        let requestedIsHidden = requestedVisibility == .detailOnly
        let currentIsHidden = currentVisibility == .detailOnly
        guard requestedIsHidden != currentIsHidden else { return nil }
        return requestedIsHidden ? .hidden : .shown
    }
}
