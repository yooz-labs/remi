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
            }
            if case .unreachable = hubClient.phase {
                // The sandboxed app cannot start the hub itself (#651);
                // point at the terminal commands and make them one copy away.
                Text("Start it with: remi start").font(.caption)
                Button("Copy Install Command (remi --install)") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("remi --install", forType: .string)
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
            // be conflated (#651).
            Toggle("Open Remi at Login", isOn: $launchAtLogin.isEnabled)
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
                .task { hubClient.start() }
        }

        Window("Remi", id: "main") {
            WebViewWindow(hubClient: hubClient)
                .frame(minWidth: 720, minHeight: 480)
        }
        .defaultSize(width: 1100, height: 760)
    }
}
