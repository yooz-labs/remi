import RemiKit
import RemiUI
import SwiftUI

/// The Mac app: a Conductor-like window over every machine's sessions (handoff/mac.md).
@main
struct RemiMacApp: App {
    var body: some Scene {
        WindowGroup {
            MacRootView()
        }
    }
}

/// Placeholder shell: machines and repositories, their sessions, the session.
struct MacRootView: View {
    var body: some View {
        NavigationSplitView {
            List {
                Section("Machines") { Text("No machines yet") }
            }
            .navigationTitle("Remi")
        } content: {
            Text("Sessions")
        } detail: {
            Text("Select a session")
                .padding(RemiTheme.Spacing.xl)
        }
    }
}

#Preview {
    MacRootView()
}
