import RemiKit
import RemiUI
import SwiftUI

@main
struct RemiMacApp: App {
    @NSApplicationDelegateAdaptor(MacNotificationDelegate.self) private var notificationDelegate
    @State private var store: MachineStore?
    private let startupError: String?

    init() {
        do {
            let identity = try ClientIdentityStore.shared.loadOrCreate()
            let clientId = Self.clientId()
            let saved = MachineConfigurationStore.shared.load()
            _store = State(initialValue: MachineStore(
                endpoints: saved.isEmpty
                    ? [MachineEndpoint(host: "127.0.0.1", port: 18765)] : saved,
                identity: identity,
                clientVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0",
                clientId: clientId
            ))
            startupError = nil
        } catch {
            _store = State(initialValue: nil)
            startupError = error.localizedDescription
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let store {
                    MacLiveRootView(store: store)
                } else {
                    ContentUnavailableView(
                        "Couldn’t load device identity",
                        systemImage: "key.slash",
                        description: Text(startupError ?? "The Keychain is unavailable.")
                    )
                }
            }
            .frame(minWidth: 980, minHeight: 640)
        }

        MenuBarExtra {
            if let store {
                MacLiveNeedsYouMenu(store: store)
            } else {
                Text("Device identity unavailable")
            }
        } label: {
            MacMenuBarLabel(store: store)
        }
    }

    private static func clientId() -> String {
        let key = "remi.native.client-id"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let value = UUID().uuidString.lowercased()
        UserDefaults.standard.set(value, forKey: key)
        return value
    }
}
