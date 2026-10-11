#if DEBUG
import SwiftUI

private struct QuestionCardGallery: View {
    private let variants = [
        RemiPreviewData.fixtureQuestion,
        RemiPreviewData.binaryQuestion,
        RemiPreviewData.standingGrantQuestion,
        RemiPreviewData.multipleChoiceQuestion,
        RemiPreviewData.genericQuestion,
        RemiPreviewData.askUserQuestion,
        RemiPreviewData.planQuestion,
        RemiPreviewData.terminalOnlyQuestion,
    ]

    var body: some View {
        ScrollView {
            LazyVStack(spacing: RemiTheme.Spacing.l) {
                ForEach(variants) { question in
                    PreviewQuestionCard(model: question)
                }

                ForEach(RemiPreviewData.questionStates) { question in
                    PreviewQuestionCard(model: question)
                }
            }
            .padding(RemiTheme.Spacing.m)
        }
    }
}

private struct SupportingComponentsGallery: View {
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
                PreviewSection(title: "Sessions") {
                    ForEach(RemiPreviewData.fixtureSessions + RemiPreviewData.sessions) { session in
                        RemiSessionRow(session: session)
                    }
                }

                PreviewSection(title: "Machines") {
                    ForEach(RemiPreviewData.machines) { machine in
                        RemiMachineRow(machine: machine)
                    }
                }

                PreviewSection(title: "Transcript") {
                    ForEach(RemiPreviewData.transcript) { entry in
                        RemiTranscriptEntryView(entry: entry)
                    }
                    RemiTranscriptEntryView(entry: .error(id: "error", text: "The connection closed before the answer was delivered."))
                }

                PreviewSection(title: "Composer") {
                    ComposerPreview(promptWaiting: false)
                    ComposerPreview(promptWaiting: true)
                }

                PreviewSection(title: "Feedback") {
                    RemiFeedbackBanner(
                        message: "The answer could not be delivered. Try again.",
                        tone: .error,
                        onDismiss: {}
                    )
                    RemiFeedbackBanner(
                        message: "Connected to the development machine.",
                        tone: .information,
                        onDismiss: {}
                    )
                }
            }
            .padding(RemiTheme.Spacing.m)
        }
    }
}

private struct PreviewQuestionCard: View {
    let model: RemiQuestionCardModel

    var body: some View {
        RemiQuestionCard(
            model: model,
            onAnswer: { _ in },
            onSubmit: { _ in },
            onCancel: {}
        )
    }
}

private struct PreviewSection<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text(title).font(.title2.weight(.bold))
            content
        }
    }
}

private struct ComposerPreview: View {
    @State private var text = "Review the next change"
    let promptWaiting: Bool

    var body: some View {
        RemiComposer(text: $text, promptWaiting: promptWaiting, onSend: {}, onInterrupt: {})
    }
}

private struct SessionInteractionGallery: View {
    @State private var draft = "Review the next change"

    var body: some View {
        VStack(spacing: RemiTheme.Spacing.l) {
            RemiSessionInteractionBar(
                draft: $draft,
                state: .liveMain(promptWaiting: false),
                onSend: { _ in },
                onInterrupt: {}
            )
            RemiSessionInteractionBar(
                draft: $draft,
                state: .liveMain(promptWaiting: true),
                onSend: { _ in },
                onInterrupt: {}
            )
            RemiSessionInteractionBar(
                draft: $draft,
                state: .liveSubagent,
                onSend: { _ in },
                onInterrupt: {}
            )
            RemiSessionInteractionBar(
                draft: $draft,
                state: .finished,
                onSend: { _ in },
                onInterrupt: {}
            )
        }
    }
}

#Preview("Question Cards · Light") {
    QuestionCardGallery().preferredColorScheme(.light)
}

#Preview("Question Cards · Dark") {
    QuestionCardGallery().preferredColorScheme(.dark)
}

#Preview("Question Cards · Accessibility") {
    QuestionCardGallery().environment(\.dynamicTypeSize, .accessibility5)
}

#Preview("Components · Light") {
    SupportingComponentsGallery().preferredColorScheme(.light)
}

#Preview("Components · Dark") {
    SupportingComponentsGallery().preferredColorScheme(.dark)
}

#Preview("Components · Accessibility") {
    SupportingComponentsGallery().environment(\.dynamicTypeSize, .accessibility5)
}

#Preview("Session Interaction · Light") {
    SessionInteractionGallery().preferredColorScheme(.light)
}

#Preview("Session Interaction · Dark") {
    SessionInteractionGallery().preferredColorScheme(.dark)
}

#Preview("Session Interaction · Accessibility") {
    SessionInteractionGallery().environment(\.dynamicTypeSize, .accessibility5)
}

#Preview("Generic decision") {
    PreviewQuestionCard(model: RemiPreviewData.genericQuestion)
        .padding(RemiTheme.Spacing.m)
}

#Preview("Resolved decision") {
    PreviewQuestionCard(model: RemiPreviewData.questionStates[2])
        .padding(RemiTheme.Spacing.m)
}
#endif
