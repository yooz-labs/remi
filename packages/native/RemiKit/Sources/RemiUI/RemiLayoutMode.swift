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

public extension View {
    /// Caps this view at `RemiTheme.Size.readableContentWidth` and centers it in the width
    /// it is offered. At compact widths the cap is not reached, so layout is unchanged; it
    /// applies at every Dynamic Type size, accessibility sizes included.
    func remiReadableColumn() -> some View {
        frame(maxWidth: RemiTheme.Size.readableContentWidth)
            .frame(maxWidth: .infinity)
    }

    /// `remiReadableColumn` for the content of a scroll view. The width follows the scroll
    /// view's own width, so the column is centered again as soon as the window turns or a
    /// sidebar opens, not at the next scroll.
    func remiReadableScrollColumn() -> some View {
        frame(maxWidth: RemiTheme.Size.readableContentWidth)
            .containerRelativeFrame(.horizontal, alignment: .center)
    }
}
