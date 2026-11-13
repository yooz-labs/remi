import Testing
@testable import RemiUI

@Suite struct RemiJumpSearchTests {
    private func session(
        _ id: String, name: String? = nil, project: String = "remi", machine: String = "Studio",
        status: RemiSessionStatus = .idle
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id, machineID: machine, machineName: machine, name: name ?? id,
            harness: "claude", project: project, status: status
        )
    }

    private func question(_ text: String, session: String, machine: String = "Studio") -> RemiQuestionCardModel {
        RemiQuestionCardModel(
            id: "q-\(session)", kind: .permission, text: text, machineID: machine, machineName: machine,
            sessionID: session, sessionName: session
        )
    }

    private func names(_ results: [RemiJumpSearch.Result]) -> [String] {
        results.map { result in
            switch result {
            case .session(let session): "session:\(session.id)"
            case .question(let card, _): "question:\(card.sessionID)"
            }
        }
    }

    @Test func anEmptyQueryListsSessionsThatNeedYouFirst() {
        let sessions = [session("idle"), session("asks", status: .needsYou), session("work", status: .working)]
        #expect(names(RemiJumpSearch.results(query: "", sessions: sessions, questions: []))
            == ["session:asks", "session:work", "session:idle"])
    }

    @Test func aQueryMatchesNameProjectAndMachineIgnoringCase() {
        let sessions = [
            session("a", name: "Protocol freeze", project: "remi", machine: "Studio"),
            session("b", name: "Notifications", project: "transit", machine: "Laptop"),
        ]
        #expect(names(RemiJumpSearch.results(query: "PROTO", sessions: sessions, questions: [])) == ["session:a"])
        #expect(names(RemiJumpSearch.results(query: "transit", sessions: sessions, questions: [])) == ["session:b"])
        #expect(names(RemiJumpSearch.results(query: "laptop", sessions: sessions, questions: [])) == ["session:b"])
    }

    @Test func everyWordMustMatchSomewhere() {
        let sessions = [session("a", name: "Protocol freeze", machine: "Studio"), session("b", name: "Protocol", machine: "Laptop")]
        #expect(names(RemiJumpSearch.results(query: "protocol studio", sessions: sessions, questions: [])) == ["session:a"])
    }

    @Test func aNameThatStartsWithTheQueryBeatsOneThatOnlyContainsIt() {
        let sessions = [session("a", name: "Old freeze"), session("b", name: "Freeze plan")]
        #expect(names(RemiJumpSearch.results(query: "freeze", sessions: sessions, questions: [])).first == "session:b")
    }

    @Test func aWaitingQuestionIsFoundByItsText() {
        let sessions = [session("s1"), session("s2")]
        let questions = [question("Allow Bash to run the test suite?", session: "s2")]
        let results = RemiJumpSearch.results(query: "test suite", sessions: sessions, questions: questions)
        #expect(names(results) == ["question:s2"])
    }

    @Test func nothingMatchesNothing() {
        #expect(RemiJumpSearch.results(query: "zzz", sessions: [session("a")], questions: []).isEmpty)
    }

    @Test func resultsAreCapped() {
        let sessions = (0..<100).map { session("s\($0)") }
        #expect(RemiJumpSearch.results(query: "", sessions: sessions, questions: []).count == RemiJumpSearch.limit)
    }

    @Test func movingTheHighlightWrapsAndHandlesNoResults() {
        #expect(RemiJumpSearch.moved(from: 0, by: 1, count: 3) == 1)
        #expect(RemiJumpSearch.moved(from: 2, by: 1, count: 3) == 0)
        #expect(RemiJumpSearch.moved(from: 0, by: -1, count: 3) == 2)
        #expect(RemiJumpSearch.moved(from: 0, by: 1, count: 0) == 0)
    }
}
