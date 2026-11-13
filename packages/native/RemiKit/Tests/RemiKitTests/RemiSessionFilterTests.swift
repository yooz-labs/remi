import Testing
@testable import RemiUI

@Suite struct RemiSessionFilterTests {
    private func session(
        _ id: String,
        machine: String = "m1",
        machineName: String = "Studio",
        name: String = "alpha",
        project: String = "proj",
        path: String? = nil,
        message: String? = nil
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machineName,
            name: name,
            harness: "Claude",
            project: project,
            projectPath: path ?? "/work/\(project)",
            status: .idle,
            lastMessage: message
        )
    }

    private func ids(_ sessions: [RemiSessionSummary]) -> [String] { sessions.map(\.id) }

    @Test func emptyAndWhitespaceQueriesDoNotFilterByText() {
        let all = [session("a"), session("b")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "", machineKey: nil)) == ["a", "b"])
        #expect(ids(RemiSessionFilter.apply(to: all, query: "  \n ", machineKey: nil)) == ["a", "b"])
    }

    @Test func matchesEachOfTheFiveFields() {
        let all = [
            session("name", name: "Needle build"),
            session("project", project: "needlework"),
            session("path", path: "/srv/needle/app"),
            session("machine", machineName: "Needle Mac"),
            session("message", message: "fixed the needle"),
            session("none"),
        ]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "needle", machineKey: nil))
            == ["name", "project", "path", "machine", "message"])
    }

    @Test func ignoresCaseAndDiacritics() {
        let all = [session("a", name: "Café Déjà"), session("b")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "CAFE deja", machineKey: nil)) == ["a"])
        #expect(ids(RemiSessionFilter.apply(to: all, query: "café", machineKey: nil)) == ["a"])
    }

    @Test func trimsTheQuery() {
        let all = [session("a", name: "alpha"), session("b", name: "beta")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "  beta ", machineKey: nil)) == ["b"])
    }

    @Test func machineKeyKeepsOnlyThatMachine() {
        let all = [session("a", machine: "m1"), session("b", machine: "m2"), session("c", machine: "m1")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "", machineKey: "m1")) == ["a", "c"])
        #expect(ids(RemiSessionFilter.apply(to: all, query: "", machineKey: "m9")).isEmpty)
    }

    @Test func machineAndTextCombine() {
        let all = [
            session("a", machine: "m1", name: "build"),
            session("b", machine: "m2", name: "build"),
            session("c", machine: "m1", name: "deploy"),
        ]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "build", machineKey: "m1")) == ["a"])
    }

    @Test func preservesInputOrder() {
        let all = [session("z", name: "x match"), session("a", name: "x match"), session("m", name: "x match")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "match", machineKey: nil)) == ["z", "a", "m"])
    }

    @Test func nothingMatchesGivesAnEmptyList() {
        #expect(RemiSessionFilter.apply(to: [session("a")], query: "zzz", machineKey: nil).isEmpty)
        #expect(RemiSessionFilter.apply(to: [], query: "a", machineKey: nil).isEmpty)
    }

    @Test func whitespaceOnlyQueryWithAMachineKeyOnlyFiltersByMachine() {
        let all = [session("a", machine: "m1"), session("b", machine: "m2")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: " \t\n ", machineKey: "m2")) == ["b"])
    }

    @Test func machineKeyAndQueryBothHaveToMatch() {
        let all = [session("a", machine: "m1", name: "build"), session("b", machine: "m2", name: "build")]
        #expect(ids(RemiSessionFilter.apply(to: all, query: "build", machineKey: "m2")) == ["b"])
        #expect(RemiSessionFilter.apply(to: all, query: "deploy", machineKey: "m2").isEmpty)
    }
}
