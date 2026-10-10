import Foundation
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
        Group {
            switch entry {
            case .user(_, let text): TranscriptMessage(text: text, role: .user)
            case .agent(_, let text): TranscriptMessage(text: text, role: .agent)
            case .tool(_, let name, let summary): TranscriptToolEntry(name: name, summary: summary)
            case .error(_, let text): TranscriptErrorEntry(text: text)
            }
        }
        .padding(isSearchMatch ? RemiTheme.Spacing.xxs : 0)
        .background(
            isSearchMatch ? Color.accentColor.opacity(isSelectedSearchMatch ? 0.14 : 0.07) : .clear,
            in: .rect(cornerRadius: RemiTheme.Radius.control)
        )
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(isSelectedSearchMatch ? Color.accentColor.opacity(0.8) : .clear, lineWidth: 2)
                .allowsHitTesting(false)
        }
        .accessibilityValue(isSelectedSearchMatch ? "Selected search result" : "")
    }
}

private struct TranscriptMessage: View {
    enum Role { case user, agent }

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let text: String
    let role: Role

    var body: some View {
        VStack(alignment: role == .user ? .trailing : .leading, spacing: RemiTheme.Spacing.xs) {
            if role == .agent {
                Label("Agent", systemImage: "sparkles")
                    .font(RemiTheme.Typography.eyebrow)
                    .foregroundStyle(.secondary)
            }
            Text(RemiTranscriptMarkup.attributed(text))
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal, role == .user ? RemiTheme.Spacing.s : 0)
                .padding(.vertical, role == .user ? RemiTheme.Spacing.xs : 0)
                .background(
                    role == .user ? AnyShapeStyle(RemiTheme.Color.attention) : AnyShapeStyle(.clear),
                    in: .rect(cornerRadius: RemiTheme.Radius.control)
                )
                .foregroundStyle(role == .user ? RemiTheme.Color.attentionInk : .primary)
                .frame(
                    maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : messageMaximumWidth,
                    alignment: role == .user ? .trailing : .leading
                )
        }
        .frame(maxWidth: .infinity, alignment: role == .user ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role == .user ? "Your message" : "Agent response")
    }

    private var messageMaximumWidth: CGFloat { role == .user ? 560 : 720 }
}

private struct TranscriptToolEntry: View {
    @State private var isExpanded = false
    let name: String
    let summary: String

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            ScrollView {
                Text(summary)
                    .font(RemiTheme.Typography.code)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, RemiTheme.Spacing.xs)
            }
            .frame(maxHeight: 260)
        } label: {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Image(systemName: "wrench.and.screwdriver").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                    Text(name).font(.subheadline.weight(.semibold))
                    Text("Tool activity").font(RemiTheme.Typography.metadata).foregroundStyle(.secondary)
                }
            }
        }
        .padding(RemiTheme.Spacing.s)
        .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
        .accessibilityHint(isExpanded ? "Collapses tool details" : "Expands tool details")
    }
}

private struct TranscriptErrorEntry: View {
    let text: String

    var body: some View {
        Label {
            Text(text)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
        }
        .font(.subheadline)
        .padding(RemiTheme.Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: .rect(cornerRadius: RemiTheme.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(Color.red.opacity(0.22), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(text)")
    }
}

enum RemiTranscriptMarkup {
    static func attributed(_ source: String) -> AttributedString {
        var value = (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(source)

        let unsafeLinkRanges = value.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard let link = run.link, !allowedLinkSchemes.contains(link.scheme?.lowercased() ?? "") else {
                return nil
            }
            return run.range
        }
        for range in unsafeLinkRanges { value[range].link = nil }
        return value
    }

    private static let allowedLinkSchemes: Set<String> = ["http", "https", "mailto"]
}
