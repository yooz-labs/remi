import Testing
@testable import RemiKit

@MainActor
@Suite struct NewSessionDraftTests {
    @Test func initializesFromFirstMachineAndRecentRepository() {
        let draft = makeDraft()

        #expect(draft.machineID == "studio:18765")
        #expect(draft.repository == "/src/remi")
        #expect(draft.availableHarnesses == ["claude", "codex"])
        #expect(draft.workspaceCapable)
    }

    @Test func changingMachineReplacesRepositoryAndRepairsCapabilities() {
        let draft = makeDraft()
        draft.repository = "/manual/path"
        draft.harness = "codex"
        draft.createsWorktree = true

        draft.machineID = "legacy:18765"

        #expect(draft.repository == "/srv/project")
        #expect(draft.harness == "claude")
        #expect(!draft.createsWorktree)
        #expect(!draft.workspaceCapable)
    }

    @Test func changingBetweenWorkspaceMachinesPreservesWorktreeMode() {
        let draft = makeDraft(includeSecondWorkspaceMachine: true)
        draft.createsWorktree = true
        draft.branch = "feature/native"

        draft.machineID = "laptop:18765"

        #expect(draft.repository == "/src/client")
        #expect(draft.createsWorktree)
        #expect(draft.harness == "claude")
        #expect(draft.destinationSummary == "New worktree on feature/native")
    }

    @Test func sameMachineAssignmentPreservesManualRepository() {
        let draft = makeDraft()
        draft.repository = "/manual/path"
        draft.machineID = draft.machineID
        #expect(draft.repository == "/manual/path")
    }

    @Test func validatesAndNormalizesWorkspaceSubmission() throws {
        let draft = makeDraft()
        draft.repository = "  /src/remi  "
        draft.createsWorktree = true
        draft.branch = "  feature/native  "
        draft.base = "  develop  "
        draft.model = "  opus  "

        let submission = try #require(draft.submission)
        #expect(submission.directory == "/src/remi")
        #expect(submission.arguments == ["--model", "opus"])
        #expect(submission.workspace == WorkspaceRequest(
            repository: "/src/remi",
            worktree: WorktreeRequest(branch: "feature/native", base: "develop")
        ))
        #expect(draft.destinationSummary == "New worktree on feature/native")
    }

    @Test func mainWorktreeSubmissionOmitsWorktreeRequest() throws {
        let draft = makeDraft()
        draft.createsWorktree = false

        let submission = try #require(draft.submission)
        #expect(submission.workspace == WorkspaceRequest(repository: "/src/remi", worktree: nil))
        #expect(draft.destinationSummary == "Repository’s main worktree")
    }

    @Test func blankOptionalBaseIsOmitted() throws {
        let draft = makeDraft()
        draft.createsWorktree = true
        draft.branch = "feature/native"
        draft.base = "  \n"

        let submission = try #require(draft.submission)
        #expect(submission.workspace?.worktree?.base == nil)
    }

    @Test func legacyMachineBuildsDirectoryOnlySubmission() throws {
        let draft = makeDraft()
        draft.machineID = "legacy:18765"

        let submission = try #require(draft.submission)
        #expect(submission.directory == "/srv/project")
        #expect(submission.workspace == nil)
        #expect(draft.destinationSummary == "Existing directory")
    }

    @Test func worktreeRequiresBranchAndEmptyHarnessListFallsBack() {
        let draft = makeDraft(emptyHarnesses: true)
        #expect(draft.availableHarnesses == ["claude"])
        draft.createsWorktree = true
        draft.branch = "  "
        #expect(!draft.canCreate)
        #expect(draft.submission == nil)
        #expect(draft.destinationSummary == "Branch required for new worktree")
    }

    private func makeDraft(
        emptyHarnesses: Bool = false,
        includeSecondWorkspaceMachine: Bool = false
    ) -> NewSessionDraft {
        var studio = MachineState(
            endpoint: MachineEndpoint(host: "studio", port: 18765),
            displayName: "Studio"
        )
        studio.capabilities = ["workspaces"]
        studio.harnesses = emptyHarnesses ? [] : ["claude", "codex"]

        var legacy = MachineState(
            endpoint: MachineEndpoint(host: "legacy", port: 18765),
            displayName: "Legacy"
        )
        legacy.harnesses = ["claude"]

        var machines = [studio, legacy]
        var repositories = [
            studio.id: [RecentRepository(repository: "/src/remi", name: "remi", lastUsedAt: "now")],
            legacy.id: [RecentRepository(repository: "/srv/project", name: "project", lastUsedAt: "now")],
        ]
        if includeSecondWorkspaceMachine {
            var laptop = MachineState(
                endpoint: MachineEndpoint(host: "laptop", port: 18765),
                displayName: "Laptop"
            )
            laptop.capabilities = ["workspaces"]
            laptop.harnesses = ["claude"]
            machines.append(laptop)
            repositories[laptop.id] = [
                RecentRepository(repository: "/src/client", name: "client", lastUsedAt: "now"),
            ]
        }

        return NewSessionDraft(
            machines: machines,
            recentRepositoriesByMachine: repositories
        )
    }
}
