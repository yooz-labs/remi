//
//  RemiApp.swift
//  Remi
//
//  Menu-bar shell for the Remi hub (#649, epic #648). A thin, sandboxed,
//  attach-only client: the hub daemon (`remi serve`) does the work; this
//  surfaces it on the Mac without a terminal.
//

import SwiftUI

@main
struct RemiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var hubClient = HubClient()
    @StateObject private var launchAtLogin = LaunchAtLogin()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra {
            Text(hubClient.menuStatusLine)
            if case .connected(_, isHub: true) = hubClient.phase {
                Text(hubClient.clientsLine)
                // #786/#787: "1 question waiting" / "N questions waiting",
                // the same census driving the notifications + icon state.
                if let questionsLine = hubClient.questionsLine {
                    Text(questionsLine)
                }
            }
            if case .unreachable = hubClient.phase {
                // The sandboxed app cannot start the hub itself (#651); the
                // onboarding panel (#773) carries the actual setup steps.
                Button("Set Up Hub…") {
                    openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                }
            }
            Divider()
            Button("Open Remi") {
                openWindow(id: "main")
                // Accessory apps do not come forward on openWindow alone.
                NSApp.activate(ignoringOtherApps: true)
            }
            .keyboardShortcut("o")
            // The APP at login — independent of the HUB's autostart (the
            // LaunchAgent installed by `remi --install`); the two must not
            // be conflated (#651). `.requiresApproval` gets its own state:
            // rendering it as an off toggle would look like a silent
            // failure with no path to resolution (#749 review).
            if launchAtLogin.needsApproval {
                Button("Login Item Pending Approval — Open System Settings") {
                    launchAtLogin.openSystemSettings()
                }
            } else {
                Toggle("Open Remi at Login", isOn: $launchAtLogin.isEnabled)
            }
            Button("Settings…") {
                // SettingsLink drives the same underlying mechanism as
                // openWindow, so it is subject to the same accessory-app
                // quirk as "Open Remi" / "Set Up Hub…" above: it does not
                // bring the app forward on its own (#777 review, finding
                // 2). Using the responder-chain action directly lets us
                // pair it with the same activate() call.
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                NSApp.activate(ignoringOtherApps: true)
            }
            .keyboardShortcut(",")
            Divider()
            Button("Quit Remi") {
                // Quits the APP only. The hub is not ours to stop: the app is
                // sandboxed (no process control) and a protocol-level stop is
                // blocked on #535 (tracked in #747). Use `remi stop`.
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
        } label: {
            // The label renders at launch (unlike the lazily-built menu
            // content), so this is the reliable startup hook for an
            // accessory app with no initial window.
            Image(hubClient.iconState.assetName)
                .opacity(hubClient.iconState.opacity)
                .task {
                    hubClient.start()
                    // #786: clicking a delivered notification activates the
                    // app and opens the main window, same as "Open Remi"
                    // below. NotificationManager has no `openWindow`
                    // environment action of its own to call.
                    hubClient.notificationManager.onNotificationActivated = {
                        openWindow(id: "main")
                        NSApp.activate(ignoringOtherApps: true)
                    }
                }
        }
        .menuBarExtraStyle(.menu)

        Window("Remi", id: "main") {
            Group {
                // Once the client has EVER connected, keep WebViewWindow
                // mounted for the app's lifetime (#777 review, finding 1):
                // phase flips away from .connected on every transient
                // disconnect (missed pong, brief network blip, hub
                // restart mid-upgrade), and gating purely on hubURL != nil
                // tore down and recreated the WKWebView — full reload,
                // lost client-side state — on each one. hasEverConnected
                // never resets, so HubSetupView is reserved for the true
                // first-run/never-connected case it was designed for.
                // WebViewWindow's own hubURL-change path (WebViewWindow.swift)
                // already handles re-injecting/reloading once a NEW hub
                // URL appears; no extra reload logic needed here.
                if hubClient.hubURL != nil || hubClient.hasEverConnected {
                    WebViewWindow(hubClient: hubClient)
                } else {
                    HubSetupView(hubClient: hubClient)
                }
            }
            .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1100, height: 760)

        Settings {
            SettingsView(hubClient: hubClient, launchAtLogin: launchAtLogin)
        }
    }
}
