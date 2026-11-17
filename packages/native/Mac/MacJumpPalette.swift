import RemiUI
import SwiftUI

/// Command-K: type to find a session, a machine's sessions or a waiting question, and press
/// Return to open it. Up and Down move the highlight, Escape closes.
struct MacJumpPalette: View {
    let sessions: [RemiSessionSummary]
    let questions: [RemiQuestionCardModel]
    let onChoose: (RemiJumpSearch.Result) -> Void
    let onClose: () -> Void

    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var fieldFocused: Bool

    private var results: [RemiJumpSearch.Result] {
        RemiJumpSearch.results(query: query, sessions: sessions, questions: questions)
    }

    var body: some View {
        VStack(spacing: 0) {
            field
            Divider()
            resultList
        }
        .frame(width: 560, height: 420)
        .onAppear { fieldFocused = true }
        .onChange(of: query) { highlighted = 0 }
        .onKeyPress(.downArrow) { move(1) }
        .onKeyPress(.upArrow) { move(-1) }
        .onKeyPress(.escape) {
            onClose()
            return .handled
        }
    }

    private var field: some View {
        HStack(spacing: RemiTheme.Spacing.xs) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Jump to a session, machine or question", text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($fieldFocused)
                .onSubmit(choose)
        }
        .padding(RemiTheme.Spacing.m)
    }

    @ViewBuilder private var resultList: some View {
        let shown = results
        if shown.isEmpty {
            ContentUnavailableView.search(text: query)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(shown.enumerated()), id: \.element.id) { index, result in
                            Button { onChoose(result) } label: {
                                row(result, isHighlighted: index == highlighted)
                            }
                            .buttonStyle(.plain)
                            .id(result.id)
                        }
                    }
                    .padding(RemiTheme.Spacing.xs)
                }
                .onChange(of: highlighted) { _, index in
                    if shown.indices.contains(index) { proxy.scrollTo(shown[index].id) }
                }
            }
        }
    }

    private func row(_ result: RemiJumpSearch.Result, isHighlighted: Bool) -> some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            switch result {
            case .session(let session):
                Circle().fill(dot(session.status)).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.name).font(.body.weight(.medium)).lineLimit(1)
                    Text("\(session.machineName) · \(session.project)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            case .question(let card, _):
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(RemiTheme.Color.activityDot)
                VStack(alignment: .leading, spacing: 1) {
                    Text(card.text).font(.body).lineLimit(1)
                    Text("\(card.machineName) · \(card.sessionName)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, RemiTheme.Spacing.s)
        .padding(.vertical, RemiTheme.Spacing.xs)
        .background(
            isHighlighted ? AnyShapeStyle(RemiTheme.Color.attention.opacity(0.28)) : AnyShapeStyle(.clear),
            in: .rect(cornerRadius: RemiTheme.Radius.compact)
        )
        .contentShape(.rect)
        .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }

    private func dot(_ status: RemiSessionStatus) -> Color {
        switch status {
        case .needsYou: RemiTheme.Color.attention
        case .working: RemiTheme.Color.activityDot
        case .connecting: .orange
        case .idle: .secondary
        case .offline: .secondary.opacity(0.4)
        }
    }

    private func move(_ offset: Int) -> KeyPress.Result {
        highlighted = RemiJumpSearch.moved(from: highlighted, by: offset, count: results.count)
        return .handled
    }

    private func choose() {
        let shown = results
        guard shown.indices.contains(highlighted) else { return }
        onChoose(shown[highlighted])
    }
}
