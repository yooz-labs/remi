import AppKit
import RemiKit
import SwiftUI

struct MacPreferencesView: View {
    let publicIdentity: PublicClientIdentity

    @State private var copiedValue: CopiedValue?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                accessCard
                identityCard
            }
            .padding(32)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .frame(width: 680, height: 560)
        .navigationTitle("Remi Settings")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Device authorization", systemImage: "key.horizontal")
                .font(.title2.weight(.semibold))
            Text("Use this Mac’s identity to approve it on each machine running Remi.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private var accessCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("What authorization allows", systemImage: "checkmark.shield")
                .font(.headline)

            Text("An authorized Remi client can view sessions exposed by that machine, read their conversations, send chat, answer approval prompts, create sessions, and stop sessions. The host daemon still controls which sessions and capabilities are available.")
                .foregroundStyle(.secondary)

            Divider()

            Label("The exported identity contains only the public key. The private key remains in this Mac’s Keychain and is not included when you copy or share.", systemImage: "lock.fill")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 14))
    }

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Public identity")
                    .font(.headline)
                Spacer()
                Text(publicIdentity.fingerprint)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Text("For a pending connection, run this on the machine you are connecting to:")
                .font(.callout)
                .foregroundStyle(.secondary)

            Text(authorizeCommand)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background, in: .rect(cornerRadius: 10))

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    actionButtons
                }
                VStack(alignment: .leading, spacing: 10) {
                    actionButtons
                }
            }
        }
        .padding(20)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 14))
    }

    private var actionButtons: some View {
        Group {
            Button(copiedValue == .command ? "Command copied" : "Copy command", systemImage: copiedValue == .command ? "checkmark" : "doc.on.doc") {
                copy(authorizeCommand, value: .command)
            }

            Button(copiedValue == .identity ? "Identity copied" : "Copy public identity", systemImage: copiedValue == .identity ? "checkmark" : "key") {
                copy(publicIdentity.exportJSON, value: .identity)
            }

            ShareLink(
                item: publicIdentity.exportJSON,
                subject: Text("Remi public identity"),
                message: Text("Install this public identity on a Remi machine to pre-authorize this Mac.")
            ) {
                Label("Share identity", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var authorizeCommand: String {
        publicIdentity.authorizeCommand(label: Host.current().localizedName ?? "Mac")
    }

    private func copy(_ string: String, value: CopiedValue) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
        copiedValue = value
    }
}

private enum CopiedValue {
    case command
    case identity
}

#Preview {
    MacPreferencesView(
        publicIdentity: PublicClientIdentity(
            publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            fingerprint: "6323efd4d1c6c63f"
        )
    )
}
