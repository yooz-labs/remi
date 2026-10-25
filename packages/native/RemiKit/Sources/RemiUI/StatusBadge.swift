import SwiftUI

public struct RemiStatusBadge: View {
    private let status: RemiSessionStatus

    public init(status: RemiSessionStatus) { self.status = status }

    public var body: some View {
        HStack(spacing: RemiTheme.Spacing.xxs) {
            Circle().fill(dot).frame(width: RemiTheme.Size.statusDot, height: RemiTheme.Size.statusDot)
            Text(label).font(RemiTheme.Typography.metadata.weight(.semibold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, RemiTheme.Spacing.xs)
        .padding(.vertical, RemiTheme.Spacing.xxs)
        .background(background, in: Capsule())
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private var label: LocalizedStringKey {
        switch status {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .idle: "Idle"
        case .connecting: "Connecting"
        // A session whose process is not running (stored, finished): not a connection problem.
        case .offline: "Finished"
        }
    }

    private var tint: Color { status == .needsYou ? RemiTheme.Color.attentionInk : .secondary }

    /// Working has its own green dot; the text stays neutral so the badge is quiet.
    private var dot: Color { status == .working ? RemiTheme.Color.activityDot : tint }

    private var background: Color {
        switch status {
        case .needsYou: RemiTheme.Color.attention
        case .working: RemiTheme.Color.activityWash
        default: RemiTheme.Color.surface
        }
    }
}
