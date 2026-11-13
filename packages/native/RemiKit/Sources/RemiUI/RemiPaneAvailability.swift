import RemiKit

/// Whether one pane can be offered for a machine, and if not, why (#1639).
///
/// A pane is offered only when the machine's `hello_ack` advertises the capability that backs
/// it, so no control is drawn for something that cannot work (DESIGN.md, principle 3).
public enum RemiPaneState: Sendable, Equatable {
    case available
    /// `reason` is for the person and, when the hub answered, names the side to update.
    case unavailable(reason: String)

    public var isAvailable: Bool { self == .available }
    public var reason: String? {
        if case .unavailable(let reason) = self { return reason }
        return nil
    }
}

/// The panes a machine can show besides chat, decided from its `hello_ack`.
///
/// - terminal: `terminal_view` advertised.
/// - files: `file_download` advertised.
///
/// A machine that is not connected, or has not answered yet, offers neither: a stale ack is not
/// evidence about a socket that is gone. Neither is offered while the route cannot carry the
/// frames (`PaneTransportPolicy`): a control for something that cannot work is not drawn. A legacy ack (no capabilities) and a capability this
/// app does not know are decided by `HubSupport.check`, so a legacy hub is told to update remi.
public struct RemiPaneAvailability: Sendable, Equatable {
    public let terminal: RemiPaneState
    public let files: RemiPaneState

    /// `transportBlock` is `PaneTransportPolicy.blockReason` for the machine's route, nil when it can carry them.
    public init(ack: HubSupportAck?, isConnected: Bool, transportBlock: String? = nil) {
        if let transportBlock {
            terminal = .unavailable(reason: transportBlock)
            files = .unavailable(reason: transportBlock)
            return
        }
        guard isConnected, let ack else {
            let reason = "Connect to this machine to see what its sessions can show."
            terminal = .unavailable(reason: reason)
            files = .unavailable(reason: reason)
            return
        }
        terminal = Self.state(ack, .terminalView)
        files = Self.state(ack, .fileDownload)
    }

    private static func state(_ ack: HubSupportAck, _ capability: HubCapability) -> RemiPaneState {
        switch HubSupport.check(ack, needs: [capability]) {
        case .supported: .available
        case .unsupported(_, _, let message): .unavailable(reason: message)
        }
    }

    /// Nothing but chat can be offered.
    public var hasAnyPane: Bool { terminal.isAvailable || files.isAvailable }

    public func state(for pane: PhoneSessionPane) -> RemiPaneState {
        switch pane {
        case .chat: .available
        case .terminal: terminal
        case .files: files
        }
    }

    /// The panes to offer, chat first. Just chat when no other pane is available.
    public var offeredPanes: [PhoneSessionPane] {
        [.chat] + (terminal.isAvailable ? [.terminal] : []) + (files.isAvailable ? [.files] : [])
    }
}
