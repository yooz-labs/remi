import Foundation

/// When the session's navigation bar may minimize on scroll, kept apart from the view so
/// the rule can be tested. The bar holds the Menu button, the only way to the drawer for
/// someone who cannot use the edge swipe, so it stays visible whenever an assistive
/// technology is running or the text is at an accessibility size.
public enum RemiNavigationBarPolicy {
    public static func minimizesOnScroll(voiceOver: Bool, switchControl: Bool, accessibilitySize: Bool) -> Bool {
        !(voiceOver || switchControl || accessibilitySize)
    }
}
