import SwiftUI

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss

    let machines: [MacMachine]
    @State private var machineID: String?
    @State private var directory = "~/Documents/git/project"
    @State private var harness = "Claude Code"
    @State private var model = "Default"

    init(machines: [MacMachine]) {
        self.machines = machines
        _machineID = State(initialValue: machines.first?.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("New session").font(.title2.weight(.semibold))

            Form {
                Picker("Machine", selection: $machineID) {
                    ForEach(machines) { machine in
                        Text(machine.name).tag(Optional(machine.id))
                    }
                }

                TextField("Directory", text: $directory)

                Picker("Harness", selection: $harness) {
                    Text("Claude Code").tag("Claude Code")
                    Text("Codex").tag("Codex")
                }

                Picker("Model", selection: $model) {
                    Text("Default").tag("Default")
                    Text("Quality").tag("Quality")
                    Text("Fast").tag("Fast")
                }
            }
            .formStyle(.grouped)

            Text("Worktree creation waits for the workspace protocol. For now, choose an existing directory.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Create") {}
                    .buttonStyle(.glassProminent)
                    .disabled(true)
                    .help("Session creation is connected in Mac M3")
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}

#Preview("New Session Sheet") {
    NewSessionSheet(machines: MacPreviewData.machines)
}

#Preview("New Session Sheet · Dark") {
    NewSessionSheet(machines: MacPreviewData.machines)
        .preferredColorScheme(.dark)
}

#Preview("New Session Sheet · Accessibility") {
    NewSessionSheet(machines: MacPreviewData.machines)
        .environment(\.dynamicTypeSize, .accessibility5)
}
