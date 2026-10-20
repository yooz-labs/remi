import Foundation
import Testing
import UserNotifications
@testable import RemiKit

struct LocalQuestionNotificationTests {
    @Test func realPermissionFixtureOffersSemanticChoices() throws {
        let message = try fixture()
        let generation = UUID()
        let plan = try #require(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: generation))
        #expect(plan.body == message.question.text)
        #expect(plan.destination.sessionID == message.sessionId)
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.yesIdentifier,
            current: message, machineID: "studio", generation: generation) == "yes")
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.noIdentifier,
            current: message, machineID: "studio", generation: generation) == "no")
    }

    @Test func categoryRequiresUnlockWithoutOpeningTheApp() {
        let category = LocalQuestionNotificationPlan.category
        #expect(category.actions.map(\.title) == ["No", "Yes"])
        #expect(category.actions.allSatisfy { $0.options.contains(.authenticationRequired) })
        #expect(category.actions.allSatisfy { !$0.options.contains(.foreground) })
    }

    @Test func actualLegacyHeldClaudeShapeKeepsItsLiteralChoices() throws {
        let legacy = try fixture { $0.removeValue(forKey: "kind") }
        let generation = UUID()
        let plan = try #require(LocalQuestionNotificationPlan(machineID: "studio", message: legacy, generation: generation))
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.noIdentifier,
            current: legacy, machineID: "studio", generation: generation) == "no")
        let unknown = try fixture { $0.removeValue(forKey: "kind"); $0.removeValue(forKey: "held") }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: unknown, generation: generation) == nil)
    }

    @Test func reversedPositionsStillSendTheOriginalSemanticValues() throws {
        let message = try fixture { question in
            var options = question["options"] as! [[String: Any]]
            options[0]["value"] = "allow-once"
            options[1]["value"] = "deny-once"
            question["options"] = Array(options.reversed())
        }
        let generation = UUID()
        let plan = try #require(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: generation))
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.noIdentifier,
            current: message, machineID: "studio", generation: generation) == "deny-once")
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.yesIdentifier,
            current: message, machineID: "studio", generation: generation) == "allow-once")
    }

    @Test(arguments: ["terminalOnly", "isAnswered", "allowsFreeText"])
    func guardedCardsHaveNoLocalActions(field: String) throws {
        let message = try fixture { $0[field] = true }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()) == nil)
    }

    @Test(arguments: ["none", "keystroke", "future-path"])
    func onlyTheStructuredAnswerPathIsActionable(path: String) throws {
        let message = try fixture { $0["answerPath"] = path }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()) == nil)
    }

    @Test(arguments: ["plan_approval", "multi_question", "future-kind"])
    func otherKindsOpenTheApp(kind: String) throws {
        let message = try fixture { $0["kind"] = kind }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()) == nil)
    }

    @Test(arguments: ["standingGrant", "sessionGrant", "description", "suggestionIndex"])
    func grantsAndHiddenOptionExplanationsAreNotPlainYes(field: String) throws {
        let message = try fixture { question in
            var options = question["options"] as! [[String: Any]]
            options[0][field] = field == "suggestionIndex" ? 0 : "future-value"
            question["options"] = options
        }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()) == nil)
    }

    @Test func extraDuplicateOrAmbiguousChoicesAreRefused() throws {
        for mutation in 0..<4 {
            let message = try fixture { question in
                var options = question["options"] as! [[String: Any]]
                switch mutation {
                case 0: options.append(options[0])
                case 1: options[1]["value"] = options[0]["value"]
                case 2: options[0]["isNo"] = true
                default: options[0]["label"] = "Yes, trust this folder"
                }
                question["options"] = options
            }
            #expect(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()) == nil)
        }
    }

    @Test func unseenDetailOrLongBodyHasNoActions() throws {
        let detail = try fixture { $0["detail"] = "Full command" }
        let long = try fixture { $0["text"] = String(repeating: "x", count: 141) }
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: detail, generation: UUID()) == nil)
        #expect(LocalQuestionNotificationPlan(machineID: "studio", message: long, generation: UUID()) == nil)
    }

    @Test func displayEscapesUntrustedText() throws {
        let message = try fixture { $0["text"] = "Allow \u{202e} Bash?" }
        let plan = try #require(LocalQuestionNotificationPlan(machineID: "studio", message: message, generation: UUID()))
        #expect(plan.body == "Allow \\u202E Bash?")
    }

    @Test func changedQuestionMachineOrConnectionCannotApplyAnOldChoice() throws {
        let original = try fixture()
        let changed = try fixture { $0["text"] = "A different command" }
        let generation = UUID()
        let plan = try #require(LocalQuestionNotificationPlan(machineID: "studio", message: original, generation: generation))
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.yesIdentifier,
            current: changed, machineID: "studio", generation: generation) == nil)
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.yesIdentifier,
            current: original, machineID: "other", generation: generation) == nil)
        #expect(plan.answerValue(identifier: LocalQuestionNotificationPlan.yesIdentifier,
            current: original, machineID: "studio", generation: UUID()) == nil)
        #expect(plan.answerValue(identifier: "OPT_0", current: original, machineID: "studio", generation: generation) == nil)
    }

    @Test @MainActor func unavailableLiveStoreRefusesAnAction() async throws {
        let message = try fixture()
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 18765)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let plan = try #require(LocalQuestionNotificationPlan(machineID: endpoint.id, message: message, generation: UUID()))
        #expect(store.localQuestionNotification(for: plan.destination) == nil)
        #expect(await store.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.yesIdentifier) == .refused)
    }

    private func fixture(change: (inout [String: Any]) -> Void = { _ in }) throws -> QuestionMessage {
        var object = try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("question_claude_permission")) as? [String: Any])
        var question = try #require(object["question"] as? [String: Any])
        change(&question)
        object["question"] = question
        return try JSONDecoder().decode(QuestionMessage.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
