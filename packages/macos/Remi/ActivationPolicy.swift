//
//  ActivationPolicy.swift
//  Remi
//
//  Pure reducer for the Dock/Cmd-Tab activation policy (#785): the app
//  launches and lives as an accessory (menu-bar only, #651) but promotes
//  itself to a regular app — Dock icon + Cmd-Tab entry — whenever a real
//  window (the main web-UI window, or Settings) is on screen, and drops
//  back to accessory the moment none are. AppDelegate owns the AppKit side
//  (window-notification wiring, NSApp.setActivationPolicy); this file only
//  answers "given N visible windows, which policy applies."
//

import Foundation

enum ActivationPolicy: Equatable {
    case regular
    case accessory

    static func derive(visibleWindowCount: Int) -> ActivationPolicy {
        visibleWindowCount > 0 ? .regular : .accessory
    }
}
