import RemiKit
import RemiUI
import SwiftUI

struct MacLiveNeedsYouMenu: View {
    let store: MachineStore

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.headline)
            if pending.isEmpty {
                Text("Nothing needs you right now.").foregroundStyle(.secondary)
            } else {
                ForEach(pending, id: \.message.question.id) { item in
                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                        Text(item.message.question.text).font(.subheadline).lineLimit(3)
                        Text(item.machine.displayName).font(.caption).foregroundStyle(.secondary)
                        if item.message.question.terminalOnly == true {
                            Label("Answer in the terminal", systemImage: "terminal")
                                .font(.caption)
                        } else if item.message.question.kind == "multi_question" {
                            Text("Open Remi to answer all questions.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(item.message.question.options, id: \.value) { option in
                                Button(option.label) {
                                    store.answer(
                                        sessionId: item.message.sessionId,
                                        questionId: item.message.question.id,
                                        answer: option.value,
                                        claudeSessionId: item.message.claudeSessionId
                                    )
                                }
                            }
                            Button("Cancel", role: .cancel) {
                                store.answer(
                                    sessionId: item.message.sessionId,
                                    questionId: item.message.question.id,
                                    answer: "",
                                    claudeSessionId: item.message.claudeSessionId,
                                    cancel: true
                                )
                            }
                        }
                    }
                    if item.message.question.id != pending.last?.message.question.id { Divider() }
                }
            }
        }
        .padding()
        .frame(width: 320)
    }

    private var pending: [(machine: MachineState, message: QuestionMessage)] {
        store.machines.flatMap { machine in
            machine.questions.map { (machine, $0) }
        }
    }
}
