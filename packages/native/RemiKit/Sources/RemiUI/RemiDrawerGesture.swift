import CoreGraphics

/// The decisions behind the phone drawer's drag, kept apart from the view so they can
/// be tested. Reduce Motion is a view concern and is not an input here.
public enum RemiDrawerGesture {
    /// The progress at which a slow release from closed settles open.
    public static let openProgressThreshold: CGFloat = 0.35
    /// A release faster than this (points per second) settles in its own direction.
    public static let velocityThreshold: CGFloat = 500

    /// A leftward, mostly horizontal drag closes an open drawer. Opening is the system
    /// edge-pan recognizer's job, so there is no rule for it here.
    public static func shouldBeginClosing(translation: CGSize) -> Bool {
        abs(translation.width) > abs(translation.height) && translation.width <= 0
    }

    /// Whether a finished drag should make the drawer ignore the taps that follow: only a
    /// mostly horizontal one. A vertical scroll of the list is not a drawer drag, and
    /// dropping the next tap after it would feel broken.
    public static func suppressesTaps(translation: CGSize) -> Bool {
        abs(translation.width) > abs(translation.height)
    }

    /// True when a drag that started at `start` began inside one of `regions`, such as a
    /// horizontally scrolling strip, which keeps the drag for itself. Both are in the same
    /// coordinate space. A region's top and left edges are inside; its right and bottom edges
    /// are outside (`CGRect.contains`), and an empty rect contains nothing.
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
