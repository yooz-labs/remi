import RemiUI
import SwiftUI

struct SessionScreen: View {
    let session: RemiSessionSummary
    let transcript: [RemiTranscriptEntry]
    let questions: [RemiQuestionCardModel]
    let onAnswer: (String, String) -> Void
    let onSubmit: (String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String) -> Void
    let onSend: (String) -> Void

    @State private var draft = ""

    init(
        session: RemiSessionSummary,
        transcript: [RemiTranscriptEntry],
        questions: [RemiQuestionCardModel],
        onAnswer: @escaping (String, String) -> Void = { _, _ in },
        onSubmit: @escaping (String, [RemiQuestionStepSelection]) -> Void = { _, _ in },
        onCancel: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String) -> Void = { _ in }
    ) {
        self.session = session
        self.transcript = transcript
        self.questions = questions
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onSend = onSend
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                    SessionIdentityHeader(
                        machineName: session.machineName,
                        project: session.project,
                        harness: session.harness,
                        status: session.status
                    )

                    ForEach(transcript) { entry in
                        RemiTranscriptEntryView(entry: entry)
                    }

                    ForEach(questions) { question in
                        RemiQuestionCard(
                            model: question,
                            onAnswer: { onAnswer(question.id, $0) },
                            onSubmit: { onSubmit(question.id, $0) },
                            onCancel: { onCancel(question.id) }
                        )
                    }
                }
                .padding(RemiTheme.Spacing.m)
            }

            Divider()

            RemiComposer(
                text: $draft,
                promptWaiting: !questions.isEmpty,
                onSend: {
                    let content = draft
                    draft = ""
                    onSend(content)
                },
                onInterrupt: {}
            )
            .padding(RemiTheme.Spacing.s)
        }
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SessionIdentityHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machineName: String
    let project: String
    let harness: String
    let status: RemiSessionStatus

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                SessionLocation(machineName: machineName, project: project, harness: harness)
                RemiStatusBadge(status: status)
            }
        } else {
            HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
                SessionLocation(machineName: machineName, project: project, harness: harness)
                Spacer(minLength: RemiTheme.Spacing.xs)
                RemiStatusBadge(status: status)
            }
        }
    }
}

private struct SessionLocation: View {
    let machineName: String
    let project: String
    let harness: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
            Text("\(machineName) / \(project)")
                .font(RemiTheme.Typography.code)
                .foregroundStyle(.secondary)
            Text(harness).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(.tertiary)
        }
    }
}
