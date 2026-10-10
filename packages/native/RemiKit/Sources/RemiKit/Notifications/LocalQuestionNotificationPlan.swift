import Foundation
import RemiPush
import UserNotifications

public enum LocalNotificationAnswerOutcome: Sendable, Equatable {
    case delivered, stale, busy, refused, uncertain
}

/// A live direct request, never a replacement for a secure relay capsule (#1141).
public struct LocalQuestionNotificationPlan: Sendable, Equatable {
    public static let categoryIdentifier = "remi.mac.permission.yn.v1"
    public static let yesIdentifier = "remi.mac.permission.yes.v1"
    public static let noIdentifier = "remi.mac.permission.no.v1"

    public static var category: UNNotificationCategory {
        UNNotificationCategory(identifier: categoryIdentifier, actions: [
            UNNotificationAction(identifier: noIdentifier, title: "No", options: [.authenticationRequired]),
            UNNotificationAction(identifier: yesIdentifier, title: "Yes", options: [.authenticationRequired]),
        ], intentIdentifiers: [], options: [])
    }

    public let destination: RemiNavigationDestination
    public let body: String
    let original: QuestionMessage
    private let generation: UUID

    init?(machineID: String, message: QuestionMessage, generation: UUID) {
        let question = message.question
        // The current Claude held binary source omits kind; unknown named kinds
        // still require the app. Preserve the actual Yes/No labels (#1141).
        let permission = question.kind == "permission" ||
            (question.kind == nil && question.held == true && message.harness == "claude")
        guard permission, question.answerPath == .structured,
              !question.hasUnknownAnswerPath, !question.isAnswered, !question.allowsFreeText,
              question.terminalOnly != true, question.detail?.isEmpty != false,
              question.questions?.isEmpty != false, question.options.count == 2 else { return nil }
        let options = question.options
        guard options.allSatisfy({
            $0.standingGrant == nil && $0.sessionGrant == nil && $0.suggestionIndex == nil &&
                $0.description == nil
        }), Set(options.map(\.value)).count == 2,
              let yes = options.first(where: { $0.isYes && !$0.isNo }),
              let no = options.first(where: { $0.isNo && !$0.isYes }),
              Self.plainLabel(yes.label) == "yes", Self.plainLabel(no.label) == "no" else { return nil }
        let displayed = PushDisplayText.escape(question.text)
        // A truncated or generated summary cannot be the text behind an approval.
        guard !displayed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              displayed.count <= 140 else { return nil }
        destination = RemiNavigationDestination(machineID: machineID, sessionID: message.sessionId,
            questionID: question.id, agentID: question.agentId)
        body = displayed
        original = message
        self.generation = generation
    }

    func answerValue(identifier: String, current: QuestionMessage,
                     machineID: String, generation: UUID) -> String? {
        guard machineID == destination.machineID, generation == self.generation,
              current == original,
              Data(current.sessionId.utf8) == Data(original.sessionId.utf8),
              Data(current.question.id.utf8) == Data(original.question.id.utf8),
              Data(current.question.text.utf8) == Data(original.question.text.utf8),
              zip(current.question.options, original.question.options).allSatisfy({
                  Data($0.value.utf8) == Data($1.value.utf8) && Data($0.label.utf8) == Data($1.label.utf8)
              }) else { return nil }
        switch identifier {
        case Self.yesIdentifier: return current.question.options.first { $0.isYes && !$0.isNo }?.value
        case Self.noIdentifier: return current.question.options.first { $0.isNo && !$0.isYes }?.value
        default: return nil
        }
    }

    private static func plainLabel(_ text: String) -> String {
        text.lowercased().unicodeScalars.filter {
            !$0.properties.isWhitespace && !(0x2500...0x257f).contains($0.value) && $0 != "|"
        }.map(String.init).joined()
    }
}
