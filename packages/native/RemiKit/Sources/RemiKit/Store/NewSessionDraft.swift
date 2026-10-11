import Foundation
import Observation

@MainActor
@Observable
public final class NewSessionDraft {
    public struct Submission: Sendable, Equatable {
        public let endpoint: MachineEndpoint
        public let directory: String
        public let harness: String
        public let arguments: [String]
        public let workspace: WorkspaceRequest?
    }

    public let machines: [MachineState]
    public let recentRepositoriesByMachine: [String: [RecentRepository]]

    public var machineID: String {
        didSet {
            guard oldValue != machineID else { return }
            selectDefaultsForCurrentMachine(replaceRepository: true)
        }
    }

    public var repository = ""
    public var harness = "claude"
    public var model = ""
    public var createsWorktree = false
    public var branch = ""
    public var base = ""

    public init(
        machines: [MachineState],
        recentRepositoriesByMachine: [String: [RecentRepository]]
    ) {
        self.machines = machines
        self.recentRepositoriesByMachine = recentRepositoriesByMachine
        machineID = machines.first?.id ?? ""
        selectDefaultsForCurrentMachine(replaceRepository: true)
    }

    public var selectedMachine: MachineState? {
        machines.first { $0.id == machineID }
    }

    public var workspaceCapable: Bool {
        selectedMachine?.capabilities.contains("workspaces") == true
    }

    public var recentRepositories: [RecentRepository] {
        recentRepositoriesByMachine[machineID] ?? []
    }

    public var availableHarnesses: [String] {
        let values = selectedMachine?.harnesses ?? ["claude"]
        return values.isEmpty ? ["claude"] : values
    }

    public var canCreate: Bool {
        selectedMachine != nil && !trimmedRepository.isEmpty && (!createsWorktree || !trimmedBranch.isEmpty)
    }

    public var destinationSummary: String {
        guard !trimmedRepository.isEmpty else { return "Choose a repository or directory" }
        if workspaceCapable, createsWorktree, !trimmedBranch.isEmpty {
            return "New worktree on \(trimmedBranch)"
        }
        return workspaceCapable ? "Repository’s main worktree" : "Existing directory"
    }

    public var submission: Submission? {
        guard let selectedMachine, canCreate else { return nil }
        let workspace: WorkspaceRequest?
        if workspaceCapable {
            let worktree = createsWorktree
                ? WorktreeRequest(branch: trimmedBranch, base: trimmedBase.nilIfEmpty)
                : nil
            workspace = WorkspaceRequest(repository: trimmedRepository, worktree: worktree)
        } else {
            workspace = nil
        }
        return Submission(
            endpoint: selectedMachine.endpoint,
            directory: trimmedRepository,
            harness: harness,
            arguments: HarnessLaunchArguments.model(model),
            workspace: workspace
        )
    }

    public static func harnessName(_ harness: String) -> String {
        switch harness {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: harness.capitalized
        }
    }

    private var trimmedRepository: String {
        repository.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBranch: String {
        branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBase: String {
        base.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func selectDefaultsForCurrentMachine(replaceRepository: Bool) {
        if !availableHarnesses.contains(harness) { harness = availableHarnesses[0] }
        if replaceRepository { repository = recentRepositories.first?.repository ?? "" }
        if !workspaceCapable { createsWorktree = false }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
