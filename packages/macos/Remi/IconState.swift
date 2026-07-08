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

    /// Template asset per state (#650, Phase C). Sources live in
    /// packages/macos/design/*.svg; regenerate the PDFs with
    /// scripts/generate-menubar-icons.sh.
    var assetName: String {
        switch self {
        case .unreachable, .idle:
            return "menubar-idle"
        case .localAttached:
            return "menubar-local"
        case .remoteConnected:
            return "menubar-remote"
        }
    }

    /// Unreachable renders the idle glyph dimmed.
    var opacity: Double {
        self == .unreachable ? 0.4 : 1.0
    }
}
