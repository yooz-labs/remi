import SwiftUI

public struct RemiQuestionCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let model: RemiQuestionCardModel
    private let onAnswer: (String) -> Void
    private let onSubmit: ([RemiQuestionStepSelection]) -> Void
    private let onCancel: () -> Void

    public init(
        model: RemiQuestionCardModel,
        onAnswer: @escaping (String) -> Void = { _ in },
        onSubmit: @escaping ([RemiQuestionStepSelection]) -> Void = { _ in },
        onCancel: @escaping () -> Void = {}
    ) {
        self.model = model
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuestionCardHeader(
                kind: model.kind,
                machineName: model.machineName,
                sessionName: model.sessionName,
                requiresAttention: requiresAttention
            )
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text(model.text).font(RemiTheme.Typography.cardTitle).fixedSize(horizontal: false, vertical: true)
                if let detail = model.detail {
                    ScrollView {
                        Text(detail).font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 240)
                    .padding(RemiTheme.Spacing.s)
                    .background(
                        reduceTransparency
                            ? AnyShapeStyle(.background)
                            : AnyShapeStyle(RemiTheme.Color.surface),
                        in: .rect(cornerRadius: RemiTheme.Radius.control)
                    )
                }
                QuestionCardContent(
                    model: model,
                    onAnswer: onAnswer,
                    onSubmit: onSubmit,
                    onCancel: onCancel
                )
            }
            .padding(RemiTheme.Spacing.m)
        }
        .background(
            reduceTransparency
                ? AnyShapeStyle(.background)
                : AnyShapeStyle(RemiTheme.Color.surface),
            in: .rect(cornerRadius: RemiTheme.Radius.card)
        )
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.card)
                .stroke(
                    requiresAttention
                        ? RemiTheme.Color.attention.opacity(0.34)
                        : Color.secondary.opacity(0.16),
                    lineWidth: 1
                )
                .allowsHitTesting(false)
        }
        .opacity(model.state == .stale ? 0.62 : 1)
        .animation(reduceMotion ? nil : RemiTheme.Motion.standard, value: model.state)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Question from \(model.sessionName) on \(model.machineName)")
    }

    private var requiresAttention: Bool {
        switch model.state {
        case .pending, .sending: true
        case .answered, .resolvedElsewhere, .stale: false
        }
    }
}

private struct QuestionCardHeader: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    let kind: RemiQuestionKind
    let machineName: String
    let sessionName: String
    let requiresAttention: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Circle()
                    .fill(requiresAttention ? RemiTheme.Color.attention : Color.secondary)
                    .frame(width: RemiTheme.Size.statusDot, height: RemiTheme.Size.statusDot)
                Text(title).font(RemiTheme.Typography.eyebrow).textCase(.uppercase).foregroundStyle(.secondary)
            }
            if dynamicTypeSize.isAccessibilitySize {
                Text("\(machineName) · \(sessionName)").font(RemiTheme.Typography.metadata).foregroundStyle(.secondary)
            } else {
                Text("\(machineName) · \(sessionName)").font(RemiTheme.Typography.metadata).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            reduceTransparency
                ? AnyShapeStyle(.background)
                : requiresAttention
                ? AnyShapeStyle(RemiTheme.Color.attention.opacity(0.1))
                : AnyShapeStyle(RemiTheme.Color.elevatedSurface)
        )
    }

    private var title: LocalizedStringKey {
        switch kind {
        case .generic: "Request"
        case .permission: "Permission request"
        case .multipleChoice: "Question"
        case .askUser: "Questions"
        case .planApproval: "Plan review"
        }
    }
}

private struct QuestionCardContent: View {
    let model: RemiQuestionCardModel
    let onAnswer: (String) -> Void
    let onSubmit: ([RemiQuestionStepSelection]) -> Void
    let onCancel: () -> Void

    var body: some View {
        switch model.state {
        case .pending:
            if model.terminalOnly {
                TerminalOnlyMessage(onCancel: onCancel)
            } else if model.kind == .askUser, !model.steps.isEmpty {
                QuestionSteps(steps: model.steps, onSubmit: onSubmit, onCancel: onCancel)
            } else {
                QuestionOptions(options: model.options, onAnswer: onAnswer, onCancel: onCancel)
            }
        case .sending: Label("Sending answer…", systemImage: "arrow.up.circle").foregroundStyle(.secondary)
        case .answered(let answer): ResolutionLabel(text: "Answered: \(answer)", systemImage: "checkmark.circle.fill")
        case .resolvedElsewhere(let source): ResolutionLabel(
            text: resolutionText(source),
            systemImage: "checkmark.circle"
        )
        case .stale: ResolutionLabel(text: "This question is no longer current", systemImage: "clock.badge.exclamationmark")
        }
    }

    private func resolutionText(_ source: RemiResolutionSource?) -> String {
        switch source {
        case .phone: "Answered from a phone"
        case .lockscreen: "Answered from the Lock Screen"
        case .terminal: "Answered at the terminal"
        case .harness: "Closed by the harness"
        case .timeout: "Remi stopped waiting for an answer"
        case nil: "Resolved elsewhere"
        }
    }
}

private struct QuestionOptions: View {
    let options: [RemiQuestionOption]
    let onAnswer: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        GlassEffectContainer(spacing: RemiTheme.Spacing.xs) {
            VStack(spacing: RemiTheme.Spacing.xs) {
                ForEach(options) { option in QuestionOptionButton(option: option) { onAnswer(option.id) } }
                Button(role: .cancel, action: onCancel) {
                    Text("Cancel")
                        .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                        .contentShape(.rect)
                }
                .buttonStyle(.glass)
            }
        }
    }
}

private struct QuestionOptionButton: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let option: RemiQuestionOption
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xs))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RemiTheme.Spacing.xs))
            layout {
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                    Text(option.label).font(.body.weight(.semibold))
                    if let detail = option.detail { Text(detail).font(.caption).foregroundStyle(option.role == .allow ? RemiTheme.Color.attentionInk : .secondary) }
                }
                if !dynamicTypeSize.isAccessibilitySize {
                    Spacer(minLength: RemiTheme.Spacing.xs)
                }
                if option.grantsForSession { Text("This session").font(.caption2.weight(.semibold)) }
                else if option.role == .allow { Text("Allow once").font(.caption2.weight(.semibold)) }
            }
            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .tint(option.role == .allow ? RemiTheme.Color.attention : nil)
        .foregroundStyle(option.role == .allow ? RemiTheme.Color.attentionInk : .primary)
        .accessibilityHint(accessibilityHint)
    }

    private var accessibilityHint: LocalizedStringKey {
        if option.grantsForSession { "Applies for this session" }
        else if option.role == .allow { "Allows once" }
        else if option.role == .deny { "Denies the request" }
        else { "Selects this answer" }
    }
}

private struct TerminalOnlyMessage: View {
    let onCancel: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("Answer this in the terminal.", systemImage: "terminal").foregroundStyle(.secondary)
            Button("Cancel", role: .cancel, action: onCancel).buttonStyle(.glass)
        }
    }
}

private struct QuestionSteps: View {
    let steps: [RemiQuestionStep]
    let onSubmit: ([RemiQuestionStepSelection]) -> Void
    let onCancel: () -> Void
    @State private var selections: [String: Set<String>] = [:]
    @State private var freeText: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
            ForEach(steps) { step in
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    if let header = step.header {
                        Text(header)
                            .font(RemiTheme.Typography.eyebrow)
                            .foregroundStyle(.primary)
                    }
                    Text(step.text).font(.subheadline.weight(.semibold))
                    if step.allowsMultipleSelection { Text("Select all that apply").font(.caption).foregroundStyle(.secondary) }
                    ForEach(step.options) { option in
                        Toggle(isOn: selectionBinding(step: step, optionID: option.id)) {
                            VStack(alignment: .leading) {
                                Text(option.label).font(.body.weight(.semibold))
                                if let detail = option.detail {
                                    Text(detail).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .toggleStyle(.button)
                    }
                    if step.allowsFreeText {
                        TextField(
                            "Write another answer",
                            text: textBinding(step: step),
                            axis: .vertical
                        )
                        .lineLimit(2...6)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Other answer for \(step.text)")

                        Text("\(trimmedText(for: step).count) / \(RemiQuestionForm.freeTextLimit)")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(
                                trimmedText(for: step).count > RemiQuestionForm.freeTextLimit
                                    ? Color.red : Color.secondary
                            )
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            GlassEffectContainer(spacing: RemiTheme.Spacing.xs) {
                VStack(spacing: RemiTheme.Spacing.xs) {
                    Button("Submit") {
                        onSubmit(formSelections)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(!formIsComplete)
                    Button(role: .cancel, action: onCancel) {
                        Text("Cancel")
                            .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.glass)
                }
            }
        }
    }

    private func selectionBinding(step: RemiQuestionStep, optionID: String) -> Binding<Bool> {
        Binding(
            get: { selections[step.id, default: []].contains(optionID) },
            set: { selected in
                if step.allowsMultipleSelection {
                    if selected { selections[step.id, default: []].insert(optionID) }
                    else { selections[step.id, default: []].remove(optionID) }
                } else {
                    selections[step.id] = selected ? [optionID] : []
                    if selected { freeText[step.id] = "" }
                }
            }
        )
    }

    private func textBinding(step: RemiQuestionStep) -> Binding<String> {
        Binding(
            get: { freeText[step.id, default: ""] },
            set: { value in
                freeText[step.id] = value
                if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    selections[step.id] = []
                }
            }
        )
    }

    private func trimmedText(for step: RemiQuestionStep) -> String {
        freeText[step.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var formIsComplete: Bool {
        RemiQuestionForm.isComplete(steps: steps, selections: formSelections)
    }

    private var formSelections: [RemiQuestionStepSelection] {
        steps.map { step in
            let text = trimmedText(for: step)
            return RemiQuestionStepSelection(
                stepID: step.id,
                optionIDs: Array(selections[step.id, default: []]).sorted(),
                text: text.isEmpty ? nil : text
            )
        }
    }
}

private struct ResolutionLabel: View {
    let text: String
    let systemImage: String
    var body: some View { Label(text, systemImage: systemImage).font(.subheadline.weight(.medium)).foregroundStyle(.secondary) }
}
