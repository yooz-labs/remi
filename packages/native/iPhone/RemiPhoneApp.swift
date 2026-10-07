import RemiKit
import RemiUI
import SwiftUI

/// The iPhone app: sessions grouped by machine, the session, and its cards (handoff/ios.md).
@main
struct RemiPhoneApp: App {
    var body: some Scene {
        WindowGroup {
            PhoneRootView()
        }
    }
}

/// Placeholder shell: sessions grouped by machine.
struct PhoneRootView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Machines") { Text("No machines yet") }
            }
            .navigationTitle("Remi")
        }
    }
}

#Preview {
    PhoneRootView()
}
