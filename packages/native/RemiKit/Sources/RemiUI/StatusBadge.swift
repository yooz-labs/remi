import SwiftUI

public struct RemiStatusBadge: View {
    private let status: RemiSessionStatus

    public init(status: RemiSessionStatus) { self.status = status }

    public var body: some View {
        HStack(spacing: RemiTheme.Spacing.xxs) {
            Circle().fill(tint).frame(width: RemiTheme.Size.statusDot, height: RemiTheme.Size.statusDot)
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
        case .offline: "Offline"
        }
    }

    private var tint: Color { status == .needsYou ? RemiTheme.Color.attention : .secondary }
    private var background: Color { status == .needsYou ? RemiTheme.Color.attention.opacity(0.14) : RemiTheme.Color.surface }
}
