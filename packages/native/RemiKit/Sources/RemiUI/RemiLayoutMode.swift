import SwiftUI

/// How much width the shell has to work with.
///
/// `compact` is the phone as it is today: one column and a drawer over it. `regular` has
/// room for a persistent sidebar beside the content. The system size class decides; a
/// width rule only stands in when the environment gives no size class (a hosting context
/// that never set one), so the two never disagree.
public enum RemiLayoutMode: Equatable, Sendable {
    case compact
    case regular

    /// The narrowest width, in points, that counts as regular when no size class is given.
    public static let regularMinimumWidth: CGFloat = 700

    public static func resolve(horizontalSizeClass: UserInterfaceSizeClass?, width: CGFloat? = nil) -> Self {
        switch horizontalSizeClass {
        case .regular: .regular
        case .compact: .compact
        case nil: (width ?? 0) >= regularMinimumWidth ? .regular : .compact
        @unknown default: .compact
        }
    }

    public var isRegular: Bool { self == .regular }
}

/// The readable column: content that would stretch across a wide canvas stays at a width
/// a person can read, centered. Below the cap it changes nothing.
public enum RemiReadableColumn {
    public static func width(available: CGFloat) -> CGFloat {
        max(0, min(available, RemiTheme.Size.readableContentWidth))
    }
}

public extension View {
    /// Caps this view at `RemiTheme.Size.readableContentWidth` and centers it in the width
    /// it is offered. At compact widths the cap is not reached, so layout is unchanged; it
    /// applies at every Dynamic Type size, accessibility sizes included.
    func remiReadableColumn() -> some View {
        frame(maxWidth: RemiTheme.Size.readableContentWidth)
            .frame(maxWidth: .infinity)
    }
}
