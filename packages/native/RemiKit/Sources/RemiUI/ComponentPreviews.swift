#if DEBUG
import SwiftUI

private struct QuestionCardGallery: View {
    private let variants = [
        RemiPreviewData.fixtureQuestion,
        RemiPreviewData.binaryQuestion,
        RemiPreviewData.standingGrantQuestion,
        RemiPreviewData.multipleChoiceQuestion,
        RemiPreviewData.askUserQuestion,
        RemiPreviewData.planQuestion,
        RemiPreviewData.terminalOnlyQuestion,
    ]

    var body: some View {
        ScrollView {
            LazyVStack(spacing: RemiTheme.Spacing.l) {
                ForEach(variants) { question in
                    RemiQuestionCard(model: question)
                }

                ForEach(RemiPreviewData.questionStates) { question in
                    RemiQuestionCard(model: question)
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
            }
            .padding(RemiTheme.Spacing.m)
        }
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
#endif
