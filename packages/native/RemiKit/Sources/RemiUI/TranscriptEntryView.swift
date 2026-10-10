import SwiftUI

public struct RemiTranscriptEntryView: View {
    private let entry: RemiTranscriptEntry
    private let isSearchMatch: Bool
    private let isSelectedSearchMatch: Bool

    public init(
        entry: RemiTranscriptEntry,
        isSearchMatch: Bool = false,
        isSelectedSearchMatch: Bool = false
    ) {
        self.entry = entry
        self.isSearchMatch = isSearchMatch
        self.isSelectedSearchMatch = isSelectedSearchMatch
    }

    public var body: some View {
        VStack {
            switch entry {
            case .user(_, let text):
                TranscriptBubble(text: text, alignment: .trailing, style: .user)
            case .agent(_, let text):
                TranscriptBubble(text: text, alignment: .leading, style: .agent)
            case .tool(_, let name, let summary):
                DisclosureGroup {
                    Text(summary).font(.caption).foregroundStyle(.secondary).padding(.top, RemiTheme.Spacing.xxs)
                } label: {
                    Label(name, systemImage: "wrench.and.screwdriver").font(.subheadline.weight(.semibold))
                }
                .padding(RemiTheme.Spacing.s)
                .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
            case .error(_, let text):
                Label(text, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(RemiTheme.Spacing.s)
                    .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
            }
        }
        .padding(isSearchMatch ? RemiTheme.Spacing.xxs : 0)
        .background(
            isSearchMatch ? Color.accentColor.opacity(isSelectedSearchMatch ? 0.14 : 0.07) : .clear,
            in: .rect(cornerRadius: RemiTheme.Radius.control)
        )
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(
                    isSelectedSearchMatch ? Color.accentColor.opacity(0.8) : .clear,
                    lineWidth: 2
                )
                .allowsHitTesting(false)
        }
        .accessibilityValue(isSelectedSearchMatch ? "Selected search result" : "")
    }
}

private struct TranscriptBubble: View {
    enum Style { case user, agent }

    let text: String
    let alignment: HorizontalAlignment
    let style: Style

    var body: some View {
        VStack(alignment: alignment) {
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal, RemiTheme.Spacing.s)
                .padding(.vertical, RemiTheme.Spacing.xs)
                .background(style == .user ? RemiTheme.Color.attention : RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
                .foregroundStyle(style == .user ? RemiTheme.Color.attentionInk : .primary)
        }
        .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
        .accessibilityLabel(style == .user ? "You: \(text)" : "Agent: \(text)")
    }
}
