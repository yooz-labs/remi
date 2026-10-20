import SwiftUI

/// Shared visual tokens for Remi's native apps.
///
/// The attention color is reserved for moments where an agent needs the person.
/// Connectivity and activity use neutral system colors so the interface stays calm.
public enum RemiTheme {
    public enum Color {
        public static let attention = SwiftUI.Color(
            red: 201.0 / 255.0,
            green: 235.0 / 255.0,
            blue: 74.0 / 255.0
        )
        public static let attentionInk = SwiftUI.Color(
            red: 26.0 / 255.0,
            green: 28.0 / 255.0,
            blue: 10.0 / 255.0
        )
        public static let surface = SwiftUI.Color.primary.opacity(0.055)
        public static let elevatedSurface = SwiftUI.Color.primary.opacity(0.09)
        public static let hairline = SwiftUI.Color.primary.opacity(0.13)
    }

    public enum Typography {
        public static let eyebrow: Font = .caption2.weight(.bold)
        public static let cardTitle: Font = .headline
        public static let body: Font = .body
        public static let metadata: Font = .caption
        public static let code: Font = .system(.caption, design: .monospaced)
    }

    public enum Spacing {
        public static let xxxs: CGFloat = 2
        public static let xxs: CGFloat = 4
        public static let xs: CGFloat = 8
        public static let s: CGFloat = 12
        public static let m: CGFloat = 16
        public static let l: CGFloat = 24
        public static let xl: CGFloat = 32
        public static let xxl: CGFloat = 48
    }

    public enum Radius {
        public static let compact: CGFloat = 8
        public static let control: CGFloat = 12
        public static let card: CGFloat = 20
    }

    public enum Motion {
        public static let quick = Animation.snappy(duration: 0.18)
        public static let standard = Animation.snappy(duration: 0.28)
    }

    public enum Size {
        public static let minimumTapTarget: CGFloat = 44
        public static let statusDot: CGFloat = 7
    }
}
