import RemiKit
import RemiUI
import SwiftUI

struct MacLiveNeedsYouMenu: View {
    let store: MachineStore

    var body: some View {
        let items = pendingQuestions

        VStack(spacing: 0) {
            MacNeedsYouHeader(
                questionCount: items.count,
                machineCount: Set(items.map(\.model.machineID)).count
            )

            Divider()

            if items.isEmpty {
                MacNeedsYouEmptyState()
            } else {
                ScrollView {
                    LazyVStack(spacing: RemiTheme.Spacing.s) {
                        ForEach(items) { item in
                            RemiQuestionCard(
                                model: item.model,
                                onAnswer: { answer(item, value: $0) },
                                onSubmit: { submit(item, selections: $0) },
                                onCancel: { cancel(item) }
                            )
                        }
                    }
                    .padding(RemiTheme.Spacing.m)
                }
                .scrollIndicators(.visible)
            }
        }
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 460)
        .frame(minHeight: 190, idealHeight: items.isEmpty ? 220 : 480, maxHeight: 620)
        .background(.background)
    }

    private var pendingQuestions: [MacPendingQuestion] {
        store.machines.flatMap { machine in
            machine.questions.map { message in
                MacPendingQuestion(machine: machine, message: message)
            }
        }
    }

    private func answer(_ item: MacPendingQuestion, value: String) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: value,
            claudeSessionId: item.claudeSessionID
        )
    }

    private func submit(_ item: MacPendingQuestion, selections: [RemiQuestionStepSelection]) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: "",
            claudeSessionId: item.claudeSessionID,
            selections: selections.compactMap { selection in
                guard let questionIndex = Int(selection.stepID) else { return nil }
                return AnswerSelection(
                    questionIndex: questionIndex,
                    optionIndices: selection.optionIDs.compactMap(Int.init).sorted(),
                    text: selection.text
                )
            }
        )
    }

    private func cancel(_ item: MacPendingQuestion) {
        store.answer(
            sessionId: item.sessionID,
            questionId: item.questionID,
            answer: "",
            claudeSessionId: item.claudeSessionID,
            cancel: true
        )
    }
}

private struct MacPendingQuestion: Identifiable {
    let model: RemiQuestionCardModel
    let sessionID: String
    let questionID: String
    let claudeSessionID: String?

    var id: String { model.id }

    init(machine: MachineState, message: QuestionMessage) {
        let question = message.question
        let kind = RemiQuestionKind(wireValue: question.kind)
        let sessionName = machine.sessions.first(where: { $0.sessionId == message.sessionId })?.name
            ?? String(message.sessionId.prefix(8))

        model = RemiQuestionCardModel(
            id: RemiQuestionCardModel.identity(
                machineID: machine.id,
                sessionID: message.sessionId,
                questionID: question.id
            ),
            questionID: question.id,
            kind: kind,
            text: question.text,
            detail: question.detail,
            machineID: machine.id,
            machineName: machine.displayName,
            sessionName: sessionName,
            options: question.options.map { option in
                RemiQuestionOption(
                    id: option.value,
                    label: option.label,
                    detail: option.description,
                    role: kind.optionRole(isYes: option.isYes, isNo: option.isNo),
                    grantsForSession: option.standingGrant != nil,
                    isRecommended: option.isRecommended
                )
            },
            steps: (question.questions ?? []).enumerated().map { index, step in
                RemiQuestionStep(
                    id: String(index),
                    header: step.header,
                    text: step.text,
                    allowsMultipleSelection: step.multiSelect,
                    allowsFreeText: !step.multiSelect,
                    options: step.options.enumerated().map { optionIndex, option in
                        RemiQuestionOption(
                            id: String(optionIndex),
                            label: option.label,
                            detail: option.description,
                            role: .neutral,
                            isRecommended: option.isRecommended
                        )
                    }
                )
            },
            terminalOnly: question.terminalOnly == true
                || question.answerPath == QuestionAnswerPath.none
                || question.hasUnknownAnswerPath,
            answerPath: Self.answerPath(question.answerPath)
        )
        sessionID = message.sessionId
        questionID = question.id
        claudeSessionID = message.claudeSessionId
    }

    private static func answerPath(_ value: QuestionAnswerPath?) -> RemiAnswerPath? {
        switch value {
        case .some(.structured): .structured
        case .some(.keystroke): .keystroke
        case .some(.none): RemiAnswerPath.none
        case nil: nil
        }
    }
}

private struct MacNeedsYouHeader: View {
    let questionCount: Int
    let machineCount: Int

    var body: some View {
        HStack(spacing: RemiTheme.Spacing.s) {
            Image(systemName: questionCount == 0 ? "checkmark" : "person.wave.2.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(questionCount == 0 ? Color.secondary : RemiTheme.Color.attentionInk)
                .frame(width: 38, height: 38)
                .background(
                    questionCount == 0 ? Color.secondary.opacity(0.12) : RemiTheme.Color.attention,
                    in: Circle()
                )

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                Text("Needs you")
                    .font(.headline)
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: RemiTheme.Spacing.s)

            if questionCount > 0 {
                Text(questionCount, format: .number)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, RemiTheme.Spacing.xs)
                    .padding(.vertical, RemiTheme.Spacing.xxxs)
                    .foregroundStyle(RemiTheme.Color.attentionInk)
                    .background(RemiTheme.Color.attention, in: Capsule())
                    .accessibilityLabel("\(questionCount) pending requests")
            }
        }
        .padding(RemiTheme.Spacing.m)
    }

    private var summary: String {
        guard questionCount > 0 else { return "All connected agents can continue." }
        let requestLabel = questionCount == 1 ? "request" : "requests"
        let machineLabel = machineCount == 1 ? "machine" : "machines"
        return "\(questionCount) \(requestLabel) across \(machineCount) \(machineLabel)"
    }
}

private struct MacNeedsYouEmptyState: View {
    var body: some View {
        ContentUnavailableView {
            Label("Nothing waiting", systemImage: "checkmark.circle")
        } description: {
            Text("Questions and permission requests will appear here when an agent needs you.")
        }
        .padding(RemiTheme.Spacing.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
