import RemiUI
import SwiftUI

struct FirstRunScreen: View {
    let onAddMachine: () -> Void

    init(onAddMachine: @escaping () -> Void = {}) {
        self.onAddMachine = onAddMachine
    }

    var body: some View {
        ContentUnavailableView {
            Label {
                Text("Your agents, wherever you are")
            } icon: {
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right").accessibilityHidden(true)
            }
        } description: {
            Text("Add a machine to see its sessions and answer the moments that need you.")
        } actions: {
            Button("Add a machine", systemImage: "desktopcomputer.and.arrow.down", action: onAddMachine)
            .buttonStyle(.glassProminent)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.xl)
    }
}

struct PhoneEmptyState: View {
    let systemImage: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(title)
            } icon: {
                Image(systemName: systemImage).accessibilityHidden(true)
            }
        } description: {
            Text(message)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }
}
