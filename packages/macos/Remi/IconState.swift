//
//  IconState.swift
//  Remi
//
//  Pure reducer for the menu-bar icon (#650, #786/#787): (reachable,
//  localClients, remoteClients, pendingQuestions) -> which glyph renders and
//  how. Precedence, per the icon spec: unreachable (dimmed idle) >
//  needsAttention (a question is pending on ANY session) > remote (filled,
//  knocked-out "r") > local (hollow "r" stroke) > idle (plain outline).
//  needsAttention outranks remote/local: "my agent needs me" is the one
//  moment the icon must grab attention regardless of who else is connected.
//  unreachable still wins over needsAttention -- with no hub connection
//  there is no question data to trust either way.
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
    case needsAttention

    static func derive(
        reachable: Bool, localClients: Int, remoteClients: Int, pendingQuestions: Int
    ) -> IconState {
        if !reachable { return .unreachable }
        if pendingQuestions > 0 { return .needsAttention }
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
        case .needsAttention:
            // #787: deliberately reuses the remoteConnected asset (filled
            // square, knocked-out "r") rather than a new glyph. The user's
            // spec was "the icon just inverts relative to its normal look" --
            // the inverted look IS the remote glyph. A distinct attention
            // treatment (e.g. a badge dot) was noted as a future option in
            // #787, not required for this precedence change.
            return "menubar-remote"
        }
    }

    /// Unreachable renders the idle glyph dimmed.
    var opacity: Double {
        self == .unreachable ? 0.4 : 1.0
    }
}
