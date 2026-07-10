//
//  HubSetupCommands.swift
//  Remi
//
//  Shared command strings for hub onboarding (#773), so HubSetupView and
//  SettingsView never drift out of sync with each other.
//

enum HubSetupCommands {
    static let install = "brew install yooz-labs/tap/remi"
    static let startHub = "remi start"
    static let autostart = "remi --install"
}
