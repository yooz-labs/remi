/// A session's identity across machines: the same session id can exist on two machines,
/// so the id alone is not unique. `machineID` is the id `MachineStore` uses (the profile
/// id), the same value a ``PhoneSessionRoute`` carries as `machineKey`.
public struct RemiSessionKey: Hashable, Sendable {
    public let machineID: String
    public let sessionID: String

    public init(machineID: String, sessionID: String) {
        self.machineID = machineID
        self.sessionID = sessionID
    }
}

extension RemiSessionSummary {
    public var key: RemiSessionKey { RemiSessionKey(machineID: machineID, sessionID: id) }
}
