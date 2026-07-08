//
//  AppDelegate.swift
//  Remi
//
//  Accessory-app lifecycle (#651): the menu-bar item is the app's identity;
//  closing the web-UI window must never terminate anything, and the app
//  never owns the hub daemon (it is an attach-only sandboxed client).
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // LSUIElement in Info.plist already makes this an accessory app
        // (no Dock icon); set explicitly so the policy survives plist edits.
        NSApp.setActivationPolicy(.accessory)
    }

    /// Window close dismisses UI only (#651 hard requirement). Accessory
    /// apps default to this, but pin it explicitly.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
