import RemiUI
import SwiftUI

struct FirstRunScreen: View {
    let onAddMachine: () -> Void

    init(onAddMachine: @escaping () -> Void = {}) {
        self.onAddMachine = onAddMachine
    }

    var body: some View {
        ContentUnavailableView {
            Label("Your agents, wherever you are", systemImage: "bubble.left.and.exclamationmark.bubble.right")
        } description: {
            Text("Add a machine to see its sessions and answer the moments that need you.")
        } actions: {
            Button("Add a machine", systemImage: "desktopcomputer.and.arrow.down", action: onAddMachine)
            .buttonStyle(.glassProminent)
            .tint(RemiTheme.Color.attention)
            .foregroundStyle(RemiTheme.Color.attentionInk)
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
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }
}
