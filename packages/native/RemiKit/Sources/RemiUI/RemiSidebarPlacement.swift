import SwiftUI

/// Resolves the phone shell's sidebar visibility from its window width and the person's choice.
public struct RemiSidebarPlacement: Equatable, Sendable {
    public enum ExplicitChoice: String, Equatable, Sendable {
        case shown
        case hidden

        public init?(storageValue: String) {
            self.init(rawValue: storageValue)
        }

        public var storageValue: String { rawValue }
    }

    public let visibility: NavigationSplitViewVisibility
    /// Whether a visible sidebar is beside the detail instead of over it.
    public let isBeside: Bool
    /// Whether this width uses the style that preserves the detail's size under the sidebar.
    public let usesProminentDetail: Bool

    public init(windowWidth: CGFloat, explicitChoice: ExplicitChoice? = nil) {
        // An unmeasured, invalid, or negative width must use the narrow-window default. Normalize
        // it before asking the Board's single threshold rule, so positive infinity is narrow too.
        let safeWindowWidth = windowWidth.isFinite && windowWidth >= 0 ? windowWidth : 0
        let wideEnoughForBeside = RemiBoardColumns.sidebarBeside(windowWidth: safeWindowWidth)
        let isShown = explicitChoice.map { $0 == .shown } ?? wideEnoughForBeside

        visibility = isShown ? .all : .detailOnly
        isBeside = isShown && wideEnoughForBeside
        usesProminentDetail = !wideEnoughForBeside
    }
}
