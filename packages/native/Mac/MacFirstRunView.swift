import RemiUI
import SwiftUI

struct MacFirstRunView: View {
    let onAddMachine: () -> Void

    init(onAddMachine: @escaping () -> Void = {}) {
        self.onAddMachine = onAddMachine
    }

    var body: some View {
        ContentUnavailableView {
            Label("Add your first machine", systemImage: "desktopcomputer.and.macbook")
        } description: {
            Text("Connect to a machine running Remi to see its sessions and questions in one window.")
        } actions: {
            Button("Add machine", systemImage: "plus", action: onAddMachine)
                .buttonStyle(.glassProminent)
        }
        .frame(minWidth: 700, minHeight: 500)
    }
}

#if DEBUG
#Preview("Mac First Run") {
    MacFirstRunView()
}
#endif
