import RemiUI
import SwiftUI

struct FirstRunScreen: View {
    var body: some View {
        ContentUnavailableView {
            Label("Your agents, wherever you are", systemImage: "bubble.left.and.exclamationmark.bubble.right")
        } description: {
            Text("Add a machine to see its sessions and answer the moments that need you.")
        } actions: {
            NavigationLink {
                PairingScreen()
            } label: {
                Text("Add a machine")
            }
            .buttonStyle(.glassProminent)
            .tint(RemiTheme.Color.attention)
            .foregroundStyle(RemiTheme.Color.attentionInk)
        }
        .navigationTitle("Remi")
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
