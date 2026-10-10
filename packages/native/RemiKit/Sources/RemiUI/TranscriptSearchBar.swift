import SwiftUI

public struct RemiTranscriptSearchBar: View {
    @Binding private var query: String
    @FocusState private var isSearchFocused: Bool
    private let resultPosition: Int?
    private let resultCount: Int
    private let onPrevious: () -> Void
    private let onNext: () -> Void
    private let onClose: () -> Void

    public init(
        query: Binding<String>,
        resultPosition: Int?,
        resultCount: Int,
        onPrevious: @escaping () -> Void,
        onNext: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        _query = query
        self.resultPosition = resultPosition
        self.resultCount = resultCount
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.onClose = onClose
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: RemiTheme.Spacing.s) {
                searchField
                resultControls
            }

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                searchField
                resultControls
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.xs)
        .background(.regularMaterial)
        .task { isSearchFocused = true }
    }

    private var searchField: some View {
        TextField("Search conversation", text: $query)
            .textFieldStyle(.roundedBorder)
            .focused($isSearchFocused)
            .accessibilityLabel("Search conversation transcript")
    }

    private var resultControls: some View {
        HStack(spacing: RemiTheme.Spacing.xxs) {
            Text(resultDescription)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .frame(minWidth: 72, alignment: .trailing)
                .accessibilityLabel(resultAccessibilityLabel)

            Button("Previous result", systemImage: "chevron.up", action: onPrevious)
                .labelStyle(.iconOnly)
                .disabled(resultCount == 0)
                .keyboardShortcut("g", modifiers: [.command, .shift])

            Button("Next result", systemImage: "chevron.down", action: onNext)
                .labelStyle(.iconOnly)
                .disabled(resultCount == 0)
                .keyboardShortcut("g", modifiers: .command)

            Button("Close search", systemImage: "xmark", action: onClose)
                .labelStyle(.iconOnly)
                .keyboardShortcut(.escape, modifiers: [])
        }
        .buttonStyle(.borderless)
        .controlSize(.large)
    }

    private var resultDescription: String {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }
        guard let resultPosition else { return "No matches" }
        return "\(resultPosition) of \(resultCount)"
    }

    private var resultAccessibilityLabel: String {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "Enter search text"
        }
        guard let resultPosition else { return "No search results" }
        return "Search result \(resultPosition) of \(resultCount)"
    }
}
