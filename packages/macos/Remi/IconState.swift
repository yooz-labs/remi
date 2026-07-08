//
//  IconState.swift
//  Remi
//
//  Pure reducer for the menu-bar icon (#650): (reachable, localClients,
//  remoteClients) -> which glyph renders and how. Precedence, per the icon
//  spec: unreachable (dimmed idle) > remote (filled, knocked-out "r") >
//  local (hollow "r" stroke) > idle (plain outline).
//
//  Phase B ships SF-Symbol placeholders; Phase C swaps in the custom
//  rounded-square "r" template assets without touching this reducer.
//

import Foundation

enum IconState: Equatable {
    case unreachable
    case idle
    case localAttached
    case remoteConnected

    static func derive(reachable: Bool, localClients: Int, remoteClients: Int) -> IconState {
        if !reachable { return .unreachable }
        if remoteClients > 0 { return .remoteConnected }
        if localClients > 0 { return .localAttached }
        return .idle
    }

    /// SF Symbol placeholder per state (Phase B). Phase C replaces these
    /// with the custom template assets (menubar-idle/-local/-remote).
    var systemImageName: String {
        switch self {
        case .unreachable, .idle:
            return "r.square"
        case .localAttached:
            return "r.square.on.square"
        case .remoteConnected:
            return "r.square.fill"
        }
    }

    /// Unreachable renders the idle glyph dimmed.
    var opacity: Double {
        self == .unreachable ? 0.4 : 1.0
    }
}
