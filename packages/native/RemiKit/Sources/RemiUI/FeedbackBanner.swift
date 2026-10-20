import SwiftUI

public enum RemiFeedbackTone: Sendable {
    case error
    case information
}

public struct RemiFeedbackBanner: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let message: String
    private let tone: RemiFeedbackTone
    private let onDismiss: () -> Void

    public init(message: String, tone: RemiFeedbackTone, onDismiss: @escaping () -> Void) {
        self.message = message
        self.tone = tone
        self.onDismiss = onDismiss
    }

    public var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            HStack(alignment: .firstTextBaseline, spacing: RemiTheme.Spacing.xs) {
                Image(systemName: systemImage)
                    .foregroundStyle(accentColor)
                    .accessibilityHidden(true)
                Text(message)
                    .foregroundStyle(.primary)
            }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)

            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .frame(
                    width: RemiTheme.Size.minimumTapTarget,
                    height: RemiTheme.Size.minimumTapTarget
                )
                .contentShape(.rect)
                .accessibilityHint("Removes this message")
        }
        .padding(.leading, RemiTheme.Spacing.s)
        .padding(.trailing, RemiTheme.Spacing.xxs)
        .padding(.vertical, RemiTheme.Spacing.xxs)
        .background(backgroundStyle, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(accentColor.opacity(0.24), lineWidth: 1)
                .allowsHitTesting(false)
        }
    }

    private var systemImage: String {
        switch tone {
        case .error: "exclamationmark.triangle.fill"
        case .information: "info.circle.fill"
        }
    }

    private var accentColor: Color {
        switch tone {
        case .error: .orange
        case .information: .blue
        }
    }

    private var backgroundStyle: AnyShapeStyle {
        reduceTransparency
            ? AnyShapeStyle(.background)
            : AnyShapeStyle(accentColor.opacity(0.08))
    }
}
