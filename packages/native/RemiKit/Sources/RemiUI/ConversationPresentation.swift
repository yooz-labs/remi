import RemiKit
import SwiftUI

public enum RemiConversationSelection {
    public static func visibleQuestions(
        _ questions: [RemiQuestionCardModel],
        selectedViewID: String,
        focusedQuestionID: String?
    ) -> [RemiQuestionCardModel] {
        guard !selectedViewID.isEmpty else { return questions }
        return questions.filter { question in
            question.agentID == selectedViewID || question.questionID == focusedQuestionID
        }
    }

    public static func title(for view: SessionViewMeta, among views: [SessionViewMeta]) -> String {
        let trimmedType = view.agentType.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = trimmedType.isEmpty ? "Subagent" : trimmedType
        let duplicateCount = views.count { candidate in
            let candidateType = candidate.agentType.trimmingCharacters(in: .whitespacesAndNewlines)
            let candidateBase = candidateType.isEmpty ? "Subagent" : candidateType
            return candidateBase.localizedCaseInsensitiveCompare(base) == .orderedSame
        }
        guard duplicateCount > 1 else { return base }
        return "\(base) · \(view.agentId.suffix(6))"
    }

    public static func reconciledViewID(
        selectedViewID: String,
        views: [SessionViewMeta],
        viewsLoaded: Bool
    ) -> String {
        guard viewsLoaded else { return selectedViewID }
        return resolvedViewID(selectedViewID: selectedViewID, views: views)
    }

    public static func resolvedViewID(
        selectedViewID: String,
        views: [SessionViewMeta]
    ) -> String {
        guard !selectedViewID.isEmpty else { return "" }
        return views.contains { $0.agentId == selectedViewID } ? selectedViewID : ""
    }

    public static func shiftedViewID(
        selectedViewID: String,
        views: [SessionViewMeta],
        offset: Int
    ) -> String {
        let conversationIDs = [""] + views.map(\.agentId)
        let currentIndex = conversationIDs.firstIndex(of: selectedViewID) ?? 0
        let normalizedOffset = ((offset % conversationIDs.count) + conversationIDs.count)
            % conversationIDs.count
        let nextIndex = (currentIndex + normalizedOffset) % conversationIDs.count
        return conversationIDs[nextIndex]
    }
}

public struct RemiConversationChip: View {
    private let title: String
    private let systemImage: String
    private let active: Bool
    private let selected: Bool
    private let action: () -> Void

    public init(
        title: String,
        systemImage: String,
        active: Bool,
        selected: Bool,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.active = active
        self.selected = selected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Image(systemName: systemImage)
                    .foregroundStyle(selected ? Color.primary : .secondary)
                Text(title).lineLimit(1)
                Circle()
                    .fill(active ? Color.primary.opacity(0.72) : Color.secondary.opacity(0.35))
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
            }
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: RemiTheme.Size.minimumTapTarget)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(
            selected ? Color.primary.opacity(0.1) : RemiTheme.Color.elevatedSurface,
            in: Capsule()
        )
        .overlay {
            Capsule()
                .stroke(
                    selected ? Color.primary.opacity(0.34) : RemiTheme.Color.hairline,
                    lineWidth: 1
                )
                .allowsHitTesting(false)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title), \(active ? "active" : "finished")")
        .accessibilityHint("Switches to this conversation")
    }
}
