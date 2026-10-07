import RemiUI
import SwiftUI

struct NeedsYouMenu: View {
    let questions: [RemiQuestionCardModel]

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.headline)
            if questions.isEmpty {
                Text("Nothing needs you right now.").foregroundStyle(.secondary)
            } else {
                ForEach(questions) { question in
                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                        Text(question.sessionName).font(.subheadline.weight(.semibold))
                        Text(question.text).font(.caption).lineLimit(2)
                        Text(question.machineName)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .frame(width: 300)
    }
}

#Preview("Needs You Menu") {
    NeedsYouMenu(questions: [RemiPreviewData.binaryQuestion])
}

#Preview("Needs You Menu · Empty") {
    NeedsYouMenu(questions: [])
}
