import Foundation

/// What the phone shell draws and listens to in each layout mode.
///
/// Compact is the drawer over the content, exactly as before. Regular shows the same
/// drawer content as a persistent sidebar beside the content, so everything that exists
/// only to open, close or dim the drawer goes away.
public struct RemiShellChrome: Equatable, Sendable {
    /// The values the drawer content reads from the environment while it is a sidebar.
    public struct SidebarEnvironment: Equatable, Sendable {
        /// No drag exists in a sidebar, so no tap is ever swallowed after one.
        public let blocksTaps = false
        /// The list follows the live order: nothing is opening or closing around it.
        public let orderFrozen = false
        /// A sidebar is not "opened", so it never pulls VoiceOver focus to its header.
        public let isOpen = false
    }

    public let usesSidebar: Bool
    public let showsMenuButton: Bool
    public let showsDrawerCloseButton: Bool
    public let showsDimLayer: Bool
    private let allowsEdgePan: Bool

    public static func resolve(mode: RemiLayoutMode) -> Self {
        let compact = mode == .compact
        return Self(
            usesSidebar: !compact,
            showsMenuButton: compact,
            showsDrawerCloseButton: compact,
            showsDimLayer: compact,
            allowsEdgePan: compact
        )
    }

    /// The drawer's screen-edge pan, which only starts an open from a closed drawer at the root.
    public func edgePanEnabled(isDrawerOpen: Bool, isAtRoot: Bool) -> Bool {
        allowsEdgePan && !isDrawerOpen && isAtRoot
    }

    /// The sidebar's environment values, nil in compact where the shell owns them.
    public var sidebarEnvironment: SidebarEnvironment? {
        usesSidebar ? SidebarEnvironment() : nil
    }
}

public extension PhoneShellState {
    /// A change of layout mode. Becoming regular puts the drawer away, because the sidebar
    /// replaces it, and keeps the selected session, filter and any question to focus.
    mutating func layoutModeChanged(to mode: RemiLayoutMode) {
        if mode == .regular { isDrawerOpen = false }
    }
}
