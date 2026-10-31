import Foundation
import SwiftUI
import Testing
import UIKit
import RemiKit
import RemiUI
@testable import NotificationBurstHost

private enum BurstTimeout: Error { case missingEvent }

@Suite(.serialized) @MainActor
struct BurstSourceTests {
    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while !condition() {
            guard ContinuousClock.now < deadline else { throw BurstTimeout.missingEvent }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    private func question(_ id: String, _ session: String, _ text: String) throws -> QuestionMessage {
        let object: [String: Any] = ["type": "question", "id": UUID().uuidString,
            "timestamp": "2026-10-30T00:00:00.000Z", "sessionId": session,
            "question": ["id": id, "text": text, "options": [], "allowsFreeText": false, "isAnswered": false]]
        return try JSONDecoder().decode(QuestionMessage.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func resolved(_ id: String, _ session: String) throws -> QuestionResolvedMessage {
        let object: [String: Any] = ["type": "question_resolved", "id": UUID().uuidString,
            "timestamp": "2026-10-30T00:00:00.000Z", "sessionId": session,
            "questionId": id, "reason": "answered", "resolvedBy": "terminal"]
        return try JSONDecoder().decode(QuestionResolvedMessage.self, from: JSONSerialization.data(withJSONObject: object))
    }
    @Test func localNotificationOrderingAndControls() async throws {
        let recorder = BurstProbe.shared
        recorder.reset()
        UserDefaults.standard.set(true, forKey: PhonePreferenceKey.questionNotifications)
        UserDefaults.standard.set(false, forKey: QuestionNotificationSummarizer.preferenceKey)
        UserDefaults.standard.set(false, forKey: PhonePreferenceKey.haptics)
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 19765), generation = UUID()
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "owned-burst-test", clientId: "owned-burst-test")
        store.ownedBurstBind(endpoint, generation: generation)
        let controller = UIHostingController(rootView: PhoneLiveRootView(store: store))
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; store.stop() }
        try await until { recorder.snapshot().contains("observe:") }
        let machine = try #require(store.machines.first?.id)
        let sessionA = "00000000-0000-4000-8000-0000000000a1", sessionB = "00000000-0000-4000-8000-0000000000b1"
        let q1 = "00000000-0000-4000-8000-000000000001", q2 = "00000000-0000-4000-8000-000000000002"
        let q3 = "00000000-0000-4000-8000-000000000003", q4 = "00000000-0000-4000-8000-000000000004"
        func key(_ session: String, _ id: String) -> String {
            RemiQuestionCardModel.identity(machineID: machine, sessionID: session, questionID: id)
        }
        func sendQuestion(_ id: String, _ session: String, _ text: String) throws {
            store.ownedBurstReceive(.question(try question(id, session, text)), endpoint: endpoint, generation: generation)
        }
        func sendResolution(_ id: String, _ session: String) throws {
            store.ownedBurstReceive(.questionResolved(try resolved(id, session)), endpoint: endpoint, generation: generation)
        }

        let stale = key(sessionA, q1)
        recorder.holdNextAdd(stale)
        try sendQuestion(q1, sessionA, "Synthetic old request")
        try await until { recorder.pendingAddRequest(for: stale) != nil }
        let staleRequest = try #require(recorder.pendingAddRequest(for: stale))
        try sendResolution(q1, sessionA)
        #expect(store.machines.allSatisfy { $0.questions.allSatisfy { $0.question.id != q1 } })
        try await until { recorder.snapshot().contains("remove:" + staleRequest.identifier) }
        recorder.releaseAdd(stale)
        try await until { recorder.snapshot().contains("finished:" + stale) }
        print("BURST_STALE_TRACE", recorder.snapshot().filter { $0.contains(stale) || $0.contains(staleRequest.identifier) })
        #expect(recorder.requests(for: stale).isEmpty, "Resolved question must not remain after the held OS add settles")

        let active = key(sessionA, q2)
        try sendQuestion(q2, sessionA, "Synthetic active request")
        try await until { recorder.requests(for: active).count == 1 }
        #expect(store.machines.contains { $0.questions.contains { $0.question.id == q2 } })
        let activeRequest = try #require(recorder.requests(for: active).first)
        try sendResolution(q2, sessionA)
        try await until { recorder.snapshot().contains("remove:" + activeRequest.identifier) }
        #expect(recorder.requests(for: active).isEmpty)

        let distinctA = key(sessionA, q3), distinctB = key(sessionB, q4)
        try sendQuestion(q3, sessionA, "Synthetic distinct A")
        try sendQuestion(q4, sessionB, "Synthetic distinct B")
        try await until { recorder.requests(for: distinctA).count == 1 && recorder.requests(for: distinctB).count == 1 }
        #expect(distinctA != distinctB)
        print("BURST_DISTINCT_TRACE", recorder.snapshot().filter { $0.hasPrefix("add:") && ($0.contains(distinctA) || $0.contains(distinctB)) })

        let q5 = "00000000-0000-4000-8000-000000000005", reused = key(sessionA, "00000000-0000-4000-8000-000000000005")
        recorder.holdNextAdd(reused)
        try sendQuestion(q5, sessionA, "Synthetic old incarnation")
        try await until { recorder.pendingAddRequest(for: reused) != nil }
        let oldRequest = try #require(recorder.pendingAddRequest(for: reused))
        try sendResolution(q5, sessionA)
        try await until { recorder.snapshot().contains("remove:" + oldRequest.identifier) }
        try sendQuestion(q5, sessionA, "Synthetic new incarnation")
        try await until { recorder.requests(for: reused).contains { $0.body == "Synthetic new incarnation" } }
        recorder.releaseAdd(reused)
        try await until { recorder.snapshot().filter { $0 == "finished:" + reused }.count == 2 }
        print("BURST_REAPPEARANCE_TRACE", recorder.snapshot().filter { $0.contains(reused) || $0.contains(oldRequest.identifier) })
        #expect(recorder.requests(for: reused).map(\.body) == ["Synthetic new incarnation"], "An old in-flight add must not replace a new incarnation")

        let q6 = "00000000-0000-4000-8000-000000000008", delayedRemoval = key(sessionA, "00000000-0000-4000-8000-000000000008")
        try sendQuestion(q6, sessionA, "Synthetic removal old")
        try await until { recorder.requests(for: delayedRemoval).count == 1 }
        let removalTarget = try #require(recorder.requests(for: delayedRemoval).first)
        recorder.holdNextRemoval(removalTarget.identifier)
        try sendResolution(q6, sessionA)
        try await until { recorder.snapshot().contains("remove:" + removalTarget.identifier) }
        try sendQuestion(q6, sessionA, "Synthetic removal new")
        try await until { recorder.requests(for: delayedRemoval).contains { $0.body == "Synthetic removal new" } }
        recorder.releaseRemoval(removalTarget.identifier)
        print("BURST_ASYNC_REMOVE_TRACE", recorder.snapshot().filter { $0.contains(delayedRemoval) || $0.contains(removalTarget.identifier) })
        #expect(recorder.requests(for: delayedRemoval).map(\.body) == ["Synthetic removal new"], "An older delayed OS removal must not erase a newer incarnation")
    }

    @Test func initialEmptyThenTwoActiveQuestionsAreObserved() async throws {
        let recorder = BurstProbe.shared
        recorder.reset()
        UserDefaults.standard.set(true, forKey: PhonePreferenceKey.questionNotifications)
        UserDefaults.standard.set(false, forKey: QuestionNotificationSummarizer.preferenceKey)
        UserDefaults.standard.set(false, forKey: PhonePreferenceKey.haptics)
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 19766), generation = UUID()
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "owned-burst-test", clientId: "owned-burst-test")
        store.ownedBurstBind(endpoint, generation: generation)
        let controller = UIHostingController(rootView: PhoneLiveRootView(store: store))
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; store.stop() }
        try await until { recorder.snapshot().contains("observe:") }
        let machine = try #require(store.machines.first?.id)
        let sessionA = "00000000-0000-4000-8000-0000000000c1", sessionB = "00000000-0000-4000-8000-0000000000d1"
        let qa = "00000000-0000-4000-8000-000000000006", qb = "00000000-0000-4000-8000-000000000007"
        let a = RemiQuestionCardModel.identity(machineID: machine, sessionID: sessionA, questionID: qa)
        let b = RemiQuestionCardModel.identity(machineID: machine, sessionID: sessionB, questionID: qb)
        store.ownedBurstReceive(.question(try question(qa, sessionA, "Synthetic delayed first")), endpoint: endpoint, generation: generation)
        store.ownedBurstReceive(.question(try question(qb, sessionB, "Synthetic delayed second")), endpoint: endpoint, generation: generation)
        try await until { recorder.requests(for: a).count == 1 && recorder.requests(for: b).count == 1 }
        #expect(a != b)
        print("BURST_INITIAL_CENSUS_TRACE", recorder.snapshot().filter { $0.hasPrefix("add:") })
    }
}
