import RemiUI
import SwiftUI

struct MacSessionDetail: View {
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
            MacSessionToolbarHeader(session: session)
            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
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
                .frame(maxWidth: 760)
                .padding(RemiTheme.Spacing.l)
                .frame(maxWidth: .infinity)
            }

            Divider()
            RemiComposer(text: $draft, promptWaiting: !questions.isEmpty, onSend: {
                let content = draft
                draft = ""
                onSend(content)
            }, onInterrupt: {})
                .padding(RemiTheme.Spacing.s)
        }
    }
}

private struct MacSessionToolbarHeader: View {
    let session: RemiSessionSummary

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text(session.name).font(.headline)
                Text("\(session.machineName) / \(session.project) · \(session.harness)")
                    .font(RemiTheme.Typography.code)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            RemiStatusBadge(status: session.status)
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.xs)
    }
}
