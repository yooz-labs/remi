import SwiftUI

/// Shared visual tokens for Remi's native apps.
///
/// The attention color is reserved for moments where an agent needs the person.
/// Running work uses a faint wash of the same hue (Remi's own green, quieter than attention);
/// connectivity uses neutral system colors so the interface stays calm.
public enum RemiTheme {
    public enum Color {
        public static let attention = SwiftUI.Color(
            red: 201.0 / 255.0,
            green: 235.0 / 255.0,
            blue: 74.0 / 255.0
        )
        /// A very pale pastel wash of the attention color for large surfaces (a message bubble):
        /// the saturated lime is for small marks only, because a big lime fill tires the eye.
        public static let attentionWash = attention.opacity(0.12)
        public static let attentionInk = SwiftUI.Color(
            red: 26.0 / 255.0,
            green: 28.0 / 255.0,
            blue: 10.0 / 255.0
        )
        /// A session that is working: a faint wash of the attention hue behind a deeper green dot.
        public static let activityWash = attention.opacity(0.15)
        public static let activityDot = SwiftUI.Color(
            red: 128.0 / 255.0,
            green: 186.0 / 255.0,
            blue: 40.0 / 255.0
        )
        /// A faint wash of the attention hue over the system sidebar material, so the iPad sidebar
        /// reads as Remi's and not as the system's blue-gray.
        public static let sidebarTint = attention.opacity(0.07)
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
        /// The widest a column of reading or answering content grows on a wide canvas.
        public static let readableContentWidth: CGFloat = 720
        /// The width of the persistent sidebar at regular width.
        public static let sidebarWidth: CGFloat = 340
    }
}
