//
//  AppDelegate.swift
//  Remi
//
//  Accessory-app lifecycle (#651): the menu-bar item is the app's identity;
//  closing the web-UI window must never terminate anything, and the app
//  never owns the hub daemon (it is an attach-only sandboxed client).
//
//  Dock/Cmd-Tab presence (#785): a permanent accessory app has no way to
//  switch back to it once another app takes focus, other than the menu-bar
//  item. While a real window (main or Settings) is open we promote to
//  .regular so the user can Cmd-Tab/Dock-click back; the moment the last
//  one closes we drop back to .accessory. ActivationPolicy.derive is the
//  pure decision; this file only wires window notifications to it.
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windowObservers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // LSUIElement in Info.plist already makes this an accessory app
        // (no Dock icon); set explicitly so the policy survives plist edits.
        NSApp.setActivationPolicy(.accessory)

        let center = NotificationCenter.default
        windowObservers = [
            // A window becoming key is our "opened" signal — SwiftUI's
            // openWindow()/showSettingsWindow: are always paired with an
            // explicit NSApp.activate() call site-side (RemiApp.swift), so
            // the new window reliably takes key status right after showing.
            center.addObserver(
                forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main
            ) { [weak self] _ in
                self?.refreshActivationPolicy()
            },
            // willClose (not didClose — AppKit has no such notification):
            // the closing window is still in NSApp.windows/isVisible at
            // this point, so it must be excluded explicitly rather than
            // relying on a post-close recount.
            center.addObserver(
                forName: NSWindow.willCloseNotification, object: nil, queue: .main
            ) { [weak self] notification in
                self?.refreshActivationPolicy(closing: notification.object as? NSWindow)
            },
        ]

        // Ordering race (#789 review): SwiftUI can present/key the launch
        // window before this callback runs, so the very first
        // didBecomeKeyNotification can fire ahead of the observers above
        // and get missed — leaving the app stuck on .accessory with a
        // visible window. Do one manual sync against whatever window state
        // already exists so the policy converges regardless of ordering.
        refreshActivationPolicy()
    }

    /// Window close dismisses UI only (#651 hard requirement). Accessory
    /// apps default to this, but pin it explicitly.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    /// Windows that count toward Dock/Cmd-Tab presence: titled, on-screen
    /// windows only. Excludes the MenuBarExtra's own borderless status-item
    /// window and any other chrome-only window AppKit may create — those
    /// are never `.titled`.
    private func isPresenceWindow(_ window: NSWindow) -> Bool {
        window.styleMask.contains(.titled)
    }

    private func refreshActivationPolicy(closing: NSWindow? = nil) {
        let visibleCount = NSApp.windows.filter {
            $0 !== closing && $0.isVisible && isPresenceWindow($0)
        }.count
        apply(ActivationPolicy.derive(visibleWindowCount: visibleCount))
    }

    private func apply(_ policy: ActivationPolicy) {
        let target: NSApplication.ActivationPolicy = policy == .regular ? .regular : .accessory
        guard NSApp.activationPolicy() != target else { return }
        if target == .accessory {
            // Known AppKit quirk: flipping .regular -> .accessory while
            // still frontmost leaves the previous menu bar (Apple menu,
            // app menu, ...) stale on screen until some other app
            // activates. Yield activation first so the transition is
            // clean (#785).
            NSApp.deactivate()
        }
        NSApp.setActivationPolicy(target)
    }
}
