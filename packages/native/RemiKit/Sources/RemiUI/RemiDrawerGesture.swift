import CoreGraphics

/// The decisions behind the phone drawer's drag, kept apart from the view so they can
/// be tested. Reduce Motion is a view concern and is not an input here.
public enum RemiDrawerGesture {
    /// How far from the left edge a drag may start and still open the drawer.
    public static let edgeWidth: CGFloat = 20
    /// The progress at which a slow release from closed settles open.
    public static let openProgressThreshold: CGFloat = 0.35
    /// A release faster than this (points per second) settles in its own direction.
    public static let velocityThreshold: CGFloat = 500

    /// Closed: only at the root, from the edge, rightward and mostly horizontal.
    /// Open: any mostly horizontal leftward drag, which closes it.
    public static func shouldBegin(startX: CGFloat, translation: CGSize, isOpen: Bool, isAtRoot: Bool) -> Bool {
        let horizontal = abs(translation.width) > abs(translation.height)
        if isOpen { return horizontal && translation.width <= 0 }
        return isAtRoot && startX <= edgeWidth && translation.width > 0 && horizontal
    }

    /// True when a drag that started at `start` began inside one of `regions`, such as a
    /// horizontally scrolling strip, which keeps the drag for itself. Both are in the same
    /// coordinate space. A region's edges count as inside.
    public static func startsInsideAny(of regions: [CGRect], at start: CGPoint) -> Bool {
        regions.contains { $0.contains(start) }
    }

    /// 0 is closed and 1 is open. A closed drawer opens with a rightward drag, an open
    /// one closes with a leftward drag. A width of zero or less returns the resting value.
    public static func progress(translationX: CGFloat, drawerWidth: CGFloat, isOpen: Bool) -> CGFloat {
        let resting: CGFloat = isOpen ? 1 : 0
        guard drawerWidth > 0 else { return resting }
        return min(1, max(0, resting + translationX / drawerWidth))
    }

    /// Where a released drag settles. Velocity beyond `velocityThreshold` wins in its
    /// direction. Otherwise a closed drawer opens at `openProgressThreshold` or more, and
    /// an open one stays open while progress is above `1 - openProgressThreshold`.
    public static func settledIsOpen(progress: CGFloat, velocityX: CGFloat, isOpen: Bool) -> Bool {
        if velocityX > velocityThreshold { return true }
        if velocityX < -velocityThreshold { return false }
        return isOpen ? progress > 1 - openProgressThreshold : progress >= openProgressThreshold
    }
}
