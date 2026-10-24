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
            case .user(_, let text): TranscriptMessage(text: text, role: .user, forceExpanded: isSearchMatch)
            case .agent(_, let text): TranscriptMessage(text: text, role: .agent, forceExpanded: isSearchMatch)
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
    @State private var isExpanded = false
    let text: String
    let role: Role
    /// A search match is never hidden inside a collapsed message.
    let forceExpanded: Bool
    private let collapse: RemiMessageCollapse

    init(text: String, role: Role, forceExpanded: Bool = false) {
        self.text = text
        self.role = role
        self.forceExpanded = forceExpanded
        collapse = RemiMessageCollapse(text: text)
    }

    private var showsFullText: Bool { isExpanded || forceExpanded || !collapse.isCollapsible }

    var body: some View {
        VStack(alignment: role == .user ? .trailing : .leading, spacing: RemiTheme.Spacing.xs) {
            if role == .agent {
                Label("Agent", systemImage: "sparkles")
                    .font(RemiTheme.Typography.eyebrow)
                    .foregroundStyle(.secondary)
            }
            Text(RemiTranscriptMarkup.attributed(showsFullText ? text : collapse.preview + "…"))
                .font(.body)
                .textSelection(.enabled)
                .padding(.horizontal, role == .user ? RemiTheme.Spacing.s : 0)
                .padding(.vertical, role == .user ? RemiTheme.Spacing.xs : 0)
                .background(
                    role == .user ? AnyShapeStyle(RemiTheme.Color.attentionWash) : AnyShapeStyle(.clear),
                    in: .rect(cornerRadius: RemiTheme.Radius.control)
                )
                .overlay {
                    if role == .user {
                        RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                            .stroke(RemiTheme.Color.attention.opacity(0.28), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                }
                .foregroundStyle(.primary)
                .frame(
                    maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : messageMaximumWidth,
                    alignment: role == .user ? .trailing : .leading
                )
            if collapse.isCollapsible, !forceExpanded {
                expandButton
            }
        }
        .frame(maxWidth: .infinity, alignment: role == .user ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role == .user ? "Your message" : "Agent response")
    }

    private var expandButton: some View {
        Button {
            isExpanded.toggle()
        } label: {
            Text(isExpanded ? "Show less" : "Show more (\(collapse.hiddenCharacterCount.formatted()) more characters)")
                .font(.subheadline.weight(.semibold))
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityHint(isExpanded ? "Collapses this long message" : "Shows the whole message")
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

/// The collapsed or expanded header of a run of tool calls (#1647). The screen owns
/// `isExpanded`, so it survives the lazy list recycling rows, and shows the group's
/// entries under the header when it is open.
public struct RemiToolGroupHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let group: RemiToolGroup
    private let isExpanded: Bool
    private let action: () -> Void

    public init(group: RemiToolGroup, isExpanded: Bool, action: @escaping () -> Void) {
        self.group = group
        self.isExpanded = isExpanded
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Image(systemName: "wrench.and.screwdriver")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                    Text(group.title).font(.subheadline.weight(.semibold))
                    Text(group.subtitle)
                        .font(RemiTheme.Typography.metadata)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                        .truncationMode(.tail)
                }
                Spacer(minLength: RemiTheme.Spacing.xs)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .flipsForRightToLeftLayoutDirection(true)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RemiTheme.Color.surface, in: .rect(cornerRadius: RemiTheme.Radius.control))
            .contentShape(.rect(cornerRadius: RemiTheme.Radius.control))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(RemiTranscriptGrouping.accessibilityLabel(count: group.count, isExpanded: isExpanded))
        .accessibilityValue(group.subtitle)
        .accessibilityHint(RemiTranscriptGrouping.accessibilityHint(isExpanded: isExpanded))
    }
}

/// The transcript rows for both apps: entries, and each tool run as a header that opens
/// in place. `expandedEntryIDs` (the entry ids of the groups the person opened) lives in the screen so it survives new entries and the
/// lazy list recycling rows. `entry` builds one entry's row, with the screen's own
/// identity, search highlight and context menu.
public struct RemiTranscriptRowsView<EntryContent: View>: View {
    private let rows: [RemiTranscriptRow]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding private var expandedEntryIDs: Set<String>
    private let entry: (RemiTranscriptEntry) -> EntryContent

    public init(
        rows: [RemiTranscriptRow],
        expandedEntryIDs: Binding<Set<String>>,
        @ViewBuilder entry: @escaping (RemiTranscriptEntry) -> EntryContent
    ) {
        self.rows = rows
        _expandedEntryIDs = expandedEntryIDs
        self.entry = entry
    }

    public var body: some View {
        ForEach(rows) { row in
            switch row {
            case .entry(let transcriptEntry):
                entry(transcriptEntry)
            case .toolGroup(let group):
                let isExpanded = RemiTranscriptGrouping.isExpanded(group, in: expandedEntryIDs)
                RemiToolGroupHeader(group: group, isExpanded: isExpanded) {
                    let toggle = { expandedEntryIDs = RemiTranscriptGrouping.toggled(group, in: expandedEntryIDs) }
                    if reduceMotion { toggle() } else { withAnimation(RemiTheme.Motion.standard, toggle) }
                }
                .id(group.id)
                if isExpanded {
                    ForEach(group.entries) { grouped in
                        entry(grouped).padding(.leading, RemiTheme.Spacing.m)
                    }
                }
            }
        }
    }
}
