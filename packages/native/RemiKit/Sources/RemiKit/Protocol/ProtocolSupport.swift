import Foundation
import RemiPush

/// The protocol version and the capabilities a daemon advertises on `hello_ack` (#1237, ADR 0035),
/// and how the app decides whether a machine can do what a screen needs.
///
/// Swift counterpart of `packages/shared/src/protocol-version.ts`. Decide with `HubSupport.check`,
/// never by comparing `daemonVersion`.
public enum ProtocolVersion {
    /// The wire's version. It changes only on a breaking change; an additive change never changes it.
    public static let current = 1

    /// The version of an ack that names none: a daemon older than #1237, whose wire is the baseline.
    public static let versionlessAck = 1
}

/// Every capability name a daemon may list in `hello_ack.capabilities`.
public enum HubCapability: String, Sendable, Equatable, CaseIterable {
    case workspaces
    case imageStaging = "image_staging"
    case imageInsertion = "image_insertion"
    case structuredChat = "structured_chat"
    case browserLinks = "browser_links"
    case fileDownload = "file_download"
    case notifications
    /// Reserved (ADR 0047): no daemon advertises it yet; it waits on the host and relay phases
    /// B3c and B4. It is in no registry in `packages/shared`, so the wording below is this app's.
    case terminalView = "terminal_view"

    /// Whether `packages/shared`'s `PROTOCOL_CAPABILITIES` lists it. A reserved name is not
    /// advertised by any daemon, so a screen that needs it is told to update the machine.
    public var isAdvertisedByDaemons: Bool { self != .terminalView }

    /// What a daemon that lists it does, phrased to follow "cannot" in a message to the person.
    public var cannotText: String {
        switch self {
        case .workspaces: "start a session in a new git worktree"
        case .imageStaging: "upload an image to the attached Claude session"
        case .imageInsertion: "add an image to the attached Claude draft"
        case .structuredChat: "send chat to the attached Codex session"
        case .browserLinks: "receive browser links from the attached Claude session"
        case .fileDownload: "download a file from the attached session"
        case .notifications: "manage paired-device background notifications"
        case .terminalView: "show the terminal of the attached session"
        }
    }

    /// The text for any capability name: the table's phrase, or the name itself when unknown.
    public static func cannotText(forName name: String) -> String {
        allCases.first { WireGuards.same($0.rawValue, name) }?.cannotText ?? name
    }
}

/// The `hello_ack` fields `HubSupport.check` reads, as a client receives them.
public struct HubSupportAck: Sendable, Equatable {
    public enum Version: Sendable, Equatable {
        /// No `protocolVersion`: an ack from a daemon older than #1237.
        case absent
        case number(Double)
        /// Present but not a number (null, text, a list, a boolean).
        case unreadable
    }

    public let protocolVersion: Version
    /// Capability names; non-text entries are dropped, and a field that is not a list counts as none.
    public let capabilities: [String]
    public let daemonVersion: String?

    public init(protocolVersion: Version = .absent, capabilities: [String] = [], daemonVersion: String? = nil) {
        self.protocolVersion = protocolVersion
        self.capabilities = capabilities
        self.daemonVersion = daemonVersion
    }

    public init(_ ack: HelloAckMessage) {
        self.init(
            protocolVersion: ack.protocolVersion.map { .number(Double($0)) } ?? .absent,
            capabilities: ack.capabilities ?? [],
            daemonVersion: ack.daemonVersion)
    }

    /// Reads the three fields from a raw `hello_ack` object, tolerating the shapes a hostile or
    /// newer daemon could send. Anything else about the ack is ignored.
    public init(json: WireJSON) {
        guard let object = json.objectValue else {
            self.init(protocolVersion: .unreadable)
            return
        }
        let version: Version
        switch object.value(for: "protocolVersion") {
        case nil: version = .absent
        case .number(let number)?: version = .number(number)
        default: version = .unreadable
        }
        var names: [String] = []
        if case .array(let items)? = object.value(for: "capabilities") {
            for case .string(let name) in items { names.append(name) }
        }
        var daemonVersion: String?
        if case .string(let text)? = object.value(for: "daemonVersion") { daemonVersion = text }
        self.init(protocolVersion: version, capabilities: names, daemonVersion: daemonVersion)
    }
}

/// Whether a machine supports what a screen needs, from its `hello_ack`.
public enum HubSupport: Sendable, Equatable {
    case supported
    /// `reason` says what failed; `missing` lists the needed capabilities the machine does not
    /// list (empty for a version mismatch); `message` is for the person and names the side to update.
    case unsupported(reason: Reason, missing: [String], message: String)

    public enum Reason: Sendable, Equatable {
        /// The versions differ or cannot be read.
        case protocolVersion
        /// One or more needed capabilities are missing.
        case capabilities
    }

    public var isSupported: Bool { self == .supported }

    public var message: String? {
        if case .unsupported(_, _, let message) = self { return message }
        return nil
    }

    private static let updateMachine = "Update remi on that machine and restart it."
    private static let maxQuotedVersion = 40

    /// Whether the machine behind `ack` supports `needs` for a client that speaks `clientVersion`.
    ///
    /// - No `protocolVersion` is version 1 with no capabilities (a legacy ack).
    /// - A version other than the client's, in either direction, or one that is not a positive
    ///   integer, is unsupported, and the message names the side to update. There is no range.
    /// - A needed capability the machine does not list is unsupported, named by what it does.
    ///
    /// Capability names the client does not know are ignored, so a newer daemon's additions
    /// cannot break an older client.
    public static func check(
        _ ack: HubSupportAck,
        needs: [String] = [],
        clientVersion: Int = ProtocolVersion.current
    ) -> HubSupport {
        let remi = quotedRemi(ack.daemonVersion)
        let version: Double
        switch ack.protocolVersion {
        case .absent: version = Double(ProtocolVersion.versionlessAck)
        case .number(let number): version = number
        case .unreadable: version = .nan
        }
        guard version.isFinite, version == version.rounded(), version >= 1, version <= 9_007_199_254_740_991 else {
            return .unsupported(
                reason: .protocolVersion, missing: [],
                message: "\(remi) sent a protocol version this app cannot read. \(updateMachine) Update this app too.")
        }
        let theirs = Int(version)
        if theirs != clientVersion {
            let update = theirs > clientVersion ? "Update this app." : updateMachine
            return .unsupported(
                reason: .protocolVersion, missing: [],
                message: "\(remi) speaks protocol version \(theirs), and this app speaks version \(clientVersion). \(update)")
        }

        var missing: [String] = []
        for name in needs
        where !missing.contains(where: { WireGuards.same($0, name) })
            && !ack.capabilities.contains(where: { WireGuards.same($0, name) }) {
            missing.append(name)
        }
        if missing.isEmpty { return .supported }
        let cannot = missing.map(HubCapability.cannotText(forName:)).joined(separator: "; ")
        return .unsupported(
            reason: .capabilities, missing: missing, message: "\(remi) cannot \(cannot). \(updateMachine)")
    }

    public static func check(
        _ ack: HubSupportAck,
        needs: [HubCapability],
        clientVersion: Int = ProtocolVersion.current
    ) -> HubSupport {
        check(ack, needs: needs.map(\.rawValue), clientVersion: clientVersion)
    }

    /// "This machine's remi (<version>)", the version escaped and cut, or without it when absent or empty.
    private static func quotedRemi(_ daemonVersion: String?) -> String {
        guard let daemonVersion, !daemonVersion.isEmpty else { return "This machine's remi" }
        // Cut before escaping, by code point, so the cut never lands inside an escape or a pair.
        let points = Array(daemonVersion.unicodeScalars)
        let shown: String
        if points.count > maxQuotedVersion {
            var cut = String.UnicodeScalarView()
            cut.append(contentsOf: points.prefix(maxQuotedVersion))
            shown = oneLine(String(cut)) + "..."
        } else {
            shown = oneLine(daemonVersion)
        }
        return "This machine's remi (\(shown))"
    }

    /// `PushDisplayText.escape`, plus the newline and tab it leaves alone, since a message is one line.
    private static func oneLine(_ text: String) -> String {
        PushDisplayText.escape(text)
            .replacingOccurrences(of: "\n", with: "\\u000A")
            .replacingOccurrences(of: "\t", with: "\\u0009")
    }
}
